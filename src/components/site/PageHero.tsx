import type { ReactNode } from 'react';
import HaloField from './HaloField';
import { cn } from '@/lib/utils';

interface PageHeroProps {
  title: string;
  description?: string;
  /** 标题上方的小标签 */
  kicker?: string;
  children?: ReactNode;
  /** 附加在标题右侧的内容（如计数徽章） */
  aside?: ReactNode;
  className?: string;
}

/**
 * 内页顶部横幅：浅红晕圈背景 + 工程网格 + 渐变标题。
 *
 * 只做视觉包装，不承载业务逻辑，children 通常放筛选标签或统计条。
 */
export function PageHero({
  title,
  description,
  kicker,
  children,
  aside,
  className,
}: PageHeroProps) {
  return (
    <section
      className={cn(
        'relative overflow-hidden border-b border-ink-900/[0.07]',
        className
      )}
    >
      <HaloField intensity={0.9} />

      <div className='relative mx-auto max-w-7xl px-4 pb-12 pt-14 sm:px-6 sm:pb-16 sm:pt-20'>
        {kicker ? (
          <p className='num mb-4 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-flare-500'>
            <span className='h-px w-8 bg-gradient-to-r from-flare-400 to-transparent' />
            {kicker}
          </p>
        ) : null}

        <div className='flex flex-wrap items-end justify-between gap-4'>
          <h1 className='text-gradient-ink text-3xl font-bold leading-tight tracking-tight sm:text-5xl'>
            {title}
          </h1>
          {aside ? <div className='shrink-0'>{aside}</div> : null}
        </div>

        {description ? (
          <p className='mt-5 max-w-3xl text-sm leading-relaxed text-ink-500 sm:text-base sm:leading-8'>
            {description}
          </p>
        ) : null}

        {children}
      </div>
    </section>
  );
}

export default PageHero;
