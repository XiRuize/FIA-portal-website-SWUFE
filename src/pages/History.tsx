import { useEffect, useMemo, useRef, useState } from 'react';
import { useContent } from '@/lib/store';
import PageHero from '@/components/site/PageHero';
import SmartImage from '@/components/site/SmartImage';
import Reveal from '@/components/site/Reveal';
import { cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/types';

/** 流线主轴在 viewBox 中的振幅与波形数 */
const AMPLITUDE = 14;
const VIEW_H = 1000;

/**
 * 生成流线型时间轴曲线的 SVG path。
 * 用正弦采样得到连续的流线：振幅很小，保证节点圆点始终落在曲线附近。
 */
function wavePath(count: number): string {
  const waves = Math.max(count - 1, 1) / 2; // 每两个节点一个完整波形
  const steps = 140;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const y = (i / steps) * VIEW_H;
    const x = 50 + AMPLITUDE * Math.sin((y / VIEW_H) * Math.PI * 2 * waves);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join(' L')}`;
}

/** 曲线在给定纵向位置处的 x（用于放置进度光点） */
function waveXAt(ratio: number, count: number): number {
  const waves = Math.max(count - 1, 1) / 2;
  return 50 + AMPLITUDE * Math.sin(ratio * Math.PI * 2 * waves);
}

interface HistoryItemProps {
  item: TimelineEvent;
  index: number;
}

function HistoryItem({ item, index }: HistoryItemProps) {
  const left = index % 2 === 0;
  return (
    <Reveal from={left ? 'left' : 'right'} delay={60}>
      <div className='relative'>
        {/* 节点圆点 */}
        <span
          className='absolute left-6 top-7 z-10 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full border-2 border-flare-400 bg-white shadow-card lg:left-1/2 lg:top-1/2 lg:-translate-y-1/2'
          aria-hidden
        >
          <span className='h-1.5 w-1.5 rounded-full bg-flare-500' />
        </span>

        <div
          className={cn(
            'pl-14 lg:w-[calc(50%-3.5rem)] lg:pl-0',
            left ? 'lg:mr-auto' : 'lg:ml-auto'
          )}
        >
          <div className='group relative overflow-hidden rounded-2xl border border-ink-900/[0.07] bg-white shadow-card transition-all duration-500 ease-smooth hover:-translate-y-1 hover:border-flare-200 hover:shadow-card-hover'>
            {/* 左侧渐变色条 */}
            <div
              aria-hidden
              className='absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-flare-400 via-flare-500 to-gold-500'
            />
            <div className='flex items-stretch'>
              <div className='flex-1 p-5 pl-6'>
                <div className='flex items-center gap-3'>
                  {/*
                    年份用**实色红**，不要用 `text-gradient-flare`：
                    那个类是从 flare-600 渐变到 gold-600，年份位数少时末尾几位正好落在
                    渐变尾端的金色上，看起来像「最后一个数字是黄色」。实色还能保证
                    深色数字在任何底色上对比度一致。
                  */}
                  <span className='num text-2xl font-bold text-flare-700 lg:text-3xl'>
                    {item.year}
                  </span>
                  <span className='hairline-x h-px flex-1' />
                  <span className='num text-[10px] text-ink-300'>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className='mt-3 text-base font-semibold text-ink-900'>
                  {item.title}
                </h3>
                {item.description ? (
                  <p className='mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-600'>
                    {item.description}
                  </p>
                ) : null}
              </div>
              {item.image ? (
                <div className='hidden w-40 shrink-0 overflow-hidden sm:block'>
                  <SmartImage
                    src={item.image}
                    alt={item.title}
                    seed={item.id}
                    className='h-full w-full transition-transform duration-700 ease-smooth group-hover:scale-105'
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/**
 * 历史沿革：滚动驱动的流线型时间轴。
 *
 * 主轴分两层绘制 —— 底层是浅色轨道，上层是高亮曲线，
 * 高亮层用 clipPath 按滚动进度逐步揭开，形成「光线顺着时间流动」的效果。
 */
export function History() {
  const { timeline, loading } = useContent();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);

  const items = useMemo(
    () => timeline.filter((t) => t.status === 'published'),
    [timeline]
  );

  // 滚动进度：容器顶部到达视口 68% 处为 0，底部到达视口 42% 处为 1
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const start = vh * 0.68;
      const span = rect.height + start - vh * 0.42;
      const p = span > 0 ? (start - rect.top) / span : 0;
      setProgress(Math.min(1, Math.max(0, p)));
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [items.length]);

  const wave = useMemo(() => wavePath(items.length), [items.length]);
  const headX = waveXAt(progress, items.length);
  const headY = progress * VIEW_H;

  return (
    <div>
      <PageHero
        kicker='our journey'
        title='历史沿革'
        description='从兴趣小组到校级社团，协会一路走来的关键节点。'
        aside={
          <span className='num rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card'>
            {String(items.length).padStart(2, '0')} 个节点
          </span>
        }
      />

      <section className='mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24'>
        {loading ? (
          <p className='text-sm text-ink-400'>正在加载…</p>
        ) : items.length ? (
          <div ref={trackRef} className='relative'>
            {/* 流线型主轴：桌面端居中，移动端靠左 */}
            <svg
              className='pointer-events-none absolute left-6 top-0 h-full w-8 -translate-x-1/2 lg:left-1/2 lg:w-32'
              viewBox={`0 0 100 ${VIEW_H}`}
              preserveAspectRatio='none'
              aria-hidden
            >
              <defs>
                <linearGradient id='history-line' x1='0' y1='0' x2='0' y2='1'>
                  <stop offset='0%' stopColor='#ff7c71' />
                  <stop offset='50%' stopColor='#f8574a' />
                  <stop offset='100%' stopColor='#c9961a' />
                </linearGradient>
                <clipPath id='history-reveal'>
                  <rect x='0' y='0' width='100' height={headY} />
                </clipPath>
              </defs>

              {/* 浅色轨道 */}
              <path
                d={wave}
                fill='none'
                stroke='#f2dcda'
                strokeWidth='2'
                strokeLinecap='round'
                vectorEffect='non-scaling-stroke'
                className='hidden lg:block'
              />
              <path
                d={`M50,0 L50,${VIEW_H}`}
                stroke='#f2dcda'
                strokeWidth='2'
                strokeLinecap='round'
                vectorEffect='non-scaling-stroke'
                className='lg:hidden'
              />

              {/* 高亮曲线：按滚动进度揭开 */}
              <g clipPath='url(#history-reveal)'>
                <path
                  d={wave}
                  fill='none'
                  stroke='url(#history-line)'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  vectorEffect='non-scaling-stroke'
                  className='hidden lg:block'
                />
                <path
                  d={`M50,0 L50,${VIEW_H}`}
                  stroke='url(#history-line)'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  vectorEffect='non-scaling-stroke'
                  className='lg:hidden'
                />
              </g>

              {/* 进度光点 */}
              {progress > 0.01 && progress < 0.995 ? (
                <circle
                  cx={headX}
                  cy={headY}
                  r='7'
                  fill='#ffffff'
                  stroke='#f8574a'
                  strokeWidth='2'
                  vectorEffect='non-scaling-stroke'
                />
              ) : null}
            </svg>

            <div className='relative space-y-10 lg:space-y-20'>
              {items.map((item, index) => (
                <HistoryItem key={item.id} item={item} index={index} />
              ))}
            </div>
          </div>
        ) : (
          <div className='rounded-2xl border border-dashed border-ink-900/12 bg-white/60 px-6 py-14 text-center text-sm text-ink-400'>
            历史沿革内容待补充，可在「内容管理 → 历史沿革」中新增时间节点。
          </div>
        )}
      </section>
    </div>
  );
}

export default History;
