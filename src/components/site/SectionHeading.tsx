import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionHeadingProps {
  title: string;
  subtitle?: string;
  /** 右侧操作区（如「查看全部」） */
  action?: ReactNode;
  align?: 'left' | 'center';
  /** 标题上方的小标签 */
  kicker?: string;
  className?: string;
}

/** 栏目标题：浅红→金渐变指示条 + 墨色渐变标题 + 描述 */
export function SectionHeading({
  title,
  subtitle,
  action,
  align = 'left',
  kicker,
  className,
}: SectionHeadingProps) {
  const centered = align === 'center';
  return (
    <div
      className={cn(
        'mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between',
        centered && 'sm:flex-col sm:items-center',
        className
      )}
    >
      <div className={cn('min-w-0', centered && 'text-center')}>
        {kicker ? (
          <p
            className={cn(
              'num mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-flare-500',
              centered && 'justify-center'
            )}
          >
            <span className='h-px w-6 bg-gradient-to-r from-flare-400 to-transparent' />
            {kicker}
          </p>
        ) : null}

        <div
          className={cn('flex items-center gap-3', centered && 'justify-center')}
        >
          <span
            aria-hidden
            className='h-6 w-0.5 shrink-0 rounded-full bg-gradient-to-b from-flare-500 to-gold-500'
          />
          <h2 className='text-gradient-ink text-2xl font-bold tracking-tight sm:text-3xl'>
            {title}
          </h2>
        </div>

        {subtitle ? (
          <p
            className={cn(
              'mt-4 max-w-3xl text-sm leading-relaxed text-ink-500 sm:text-base',
              centered && 'mx-auto'
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className='shrink-0'>{action}</div> : null}
    </div>
  );
}

export default SectionHeading;
