import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Article } from '@/lib/types';
import { cn } from '@/lib/utils';
import HaloField from './HaloField';

const INTERVAL_MS = 7000;

interface HeroCarouselProps {
  items: Article[];
}

/**
 * 首页主视觉轮播（白底版）。
 *
 * ## 2026-09-27：删去背景配图
 *
 * 原先每一帧在文案后面压一张 `cover` 大图（交叉淡入 + Ken Burns 推近），
 * 再叠一层由白到透明的渐变保证黑字可读。现按需求**去掉所有背景图**，
 * 只保留文案层与框架（栅格纹理、光晕、页码、左右切换、进度条），
 * 章节背景回归纯白，与上下的白色版块自然衔接。
 *
 * 随之删掉的两层：为配图服务的「白底可读性渐变」与「底部融入页面渐变」
 * —— 它们是**配图的辅助层**而非框架，没有配图后只剩装饰噪音。
 *
 * 文案层仍按当前下标重新挂载，从而重放逐条上浮的入场动效。
 */
export function HeroCarousel({ items }: HeroCarouselProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | null>(null);

  const count = items.length;

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
    },
    [count]
  );

  useEffect(() => {
    if (paused || count <= 1) return;
    timer.current = window.setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, INTERVAL_MS);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [paused, count]);

  useEffect(() => {
    if (index >= count) setIndex(0);
  }, [count, index]);

  // 无轮播内容时：晕圈 + 标语兜底，不留白屏
  if (count === 0) {
    return (
      <section className='relative flex min-h-[78vh] items-center justify-center overflow-hidden'>
        <HaloField intensity={1} />
        <div className='relative px-6 text-center'>
          <p className='num text-[11px] uppercase tracking-[0.28em] text-flare-500'>
            southwest university of finance and economics
          </p>
          <p className='text-gradient-ink mt-6 text-3xl font-bold sm:text-5xl'>
            以研究立身 · 以投资会友
          </p>
          <p className='mt-5 text-sm text-ink-500'>
            首页轮播图待上传，可在「内容管理 → 内容条目 → 首页轮播」中添加。
          </p>
        </div>
      </section>
    );
  }

  const active = items[index];

  return (
    <section
      className='relative min-h-[88vh] overflow-hidden bg-white'
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription='轮播'
      aria-label='首页主视觉'
    >
      {/* 框架层：栅格纹理 + 角落光晕（不再有背景配图） */}
      <div aria-hidden className='absolute inset-0 bg-grid opacity-60' />
      <div
        aria-hidden
        className='pointer-events-none absolute -left-24 top-1/4 h-[34rem] w-[34rem] animate-halo-a rounded-full bg-flare-300/30 blur-[120px]'
      />
      <HaloField intensity={0.85} />

      {/* 文案层：换片时重新挂载以重放动效 */}
      <div className='relative mx-auto flex min-h-[88vh] max-w-7xl flex-col justify-center px-4 py-24 sm:px-6'>
        <div key={active.id} className='max-w-3xl'>
          {active.subtitle ? (
            <span className='animate-rise inline-flex items-center gap-2 rounded-full border border-flare-200 bg-flare-50 px-3.5 py-1.5 text-xs font-medium text-flare-700'>
              <span className='h-1.5 w-1.5 rounded-full bg-flare-500' />
              {active.subtitle}
            </span>
          ) : null}

          <h2
            className='animate-rise mt-6 text-3xl font-bold leading-[1.15] tracking-tight text-ink-900 sm:text-5xl lg:text-6xl'
            style={{ animationDelay: '90ms' }}
          >
            {active.title}
          </h2>

          {active.summary ? (
            <p
              className='animate-rise mt-6 max-w-xl text-sm leading-relaxed text-ink-600 sm:text-base sm:leading-8'
              style={{ animationDelay: '190ms' }}
            >
              {active.summary}
            </p>
          ) : null}

          <div
            className='animate-rise mt-9 flex flex-wrap items-center gap-3'
            style={{ animationDelay: '290ms' }}
          >
            <HeroLink item={active} />
            <Link
              to='/news?tab=finance'
              className='inline-flex items-center gap-2 rounded-lg border border-ink-900/12 bg-white px-5 py-3 text-sm font-medium text-ink-700 shadow-card transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600'
            >
              查看行情终端
            </Link>
          </div>
        </div>
      </div>

      {/* 右下角页码 */}
      {count > 1 ? (
        <div className='num absolute bottom-14 right-4 hidden items-baseline gap-1 text-xs text-ink-400 sm:right-6 sm:flex'>
          <span className='text-2xl font-semibold text-ink-900'>
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className='h-px w-6 bg-ink-900/20' />
          <span>{String(count).padStart(2, '0')}</span>
        </div>
      ) : null}

      {/* 左右切换 */}
      {count > 1 ? (
        <>
          <button
            type='button'
            onClick={() => go(index - 1)}
            className='group absolute left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-ink-900/10 bg-white/85 text-ink-600 shadow-card backdrop-blur transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600 sm:flex'
            aria-label='上一张'
          >
            <ChevronLeft className='h-5 w-5 transition-transform group-hover:-translate-x-0.5' />
          </button>
          <button
            type='button'
            onClick={() => go(index + 1)}
            className='group absolute right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-ink-900/10 bg-white/85 text-ink-600 shadow-card backdrop-blur transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600 sm:flex'
            aria-label='下一张'
          >
            <ChevronRight className='h-5 w-5 transition-transform group-hover:translate-x-0.5' />
          </button>

          {/* 进度条指示器 */}
          <div className='absolute bottom-8 left-4 flex items-center gap-2 sm:left-6'>
            {items.map((item, i) => (
              <button
                key={`dot-${item.id}`}
                type='button'
                onClick={() => go(i)}
                aria-label={`第 ${i + 1} 张`}
                aria-current={i === index}
                className={cn(
                  'h-1 overflow-hidden rounded-full bg-ink-900/15 transition-all duration-500 ease-smooth',
                  i === index ? 'w-14' : 'w-6 hover:bg-ink-900/30'
                )}
              >
                <span
                  key={`fill-${index}-${i}`}
                  className={cn(
                    'block h-full rounded-full bg-gradient-to-r from-flare-400 to-gold-500',
                    i === index && 'animate-grow'
                  )}
                  style={{
                    animationDuration: `${INTERVAL_MS}ms`,
                    animationPlayState: paused ? 'paused' : 'running',
                    transformOrigin: 'left',
                    transform: i === index ? undefined : 'scaleX(0)',
                  }}
                />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** 主按钮：跟随 banner 的内链 / 外链目标 */
function HeroLink({ item }: { item: Article }) {
  const href = item.linkUrl || `/article/${item.id}`;
  const external = /^https?:\/\//.test(item.linkUrl);
  const className =
    'group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-flare-500 to-flare-600 px-5 py-3 text-sm font-semibold text-white shadow-glow-flare transition-all duration-300 ease-smooth hover:brightness-110';
  const inner = (
    <>
      了解详情
      <ArrowRight className='h-4 w-4 transition-transform duration-300 group-hover:translate-x-1' />
    </>
  );

  if (external) {
    return (
      <a href={href} target='_blank' rel='noreferrer' className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {inner}
    </Link>
  );
}

export default HeroCarousel;
