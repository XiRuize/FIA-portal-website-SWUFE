import { Link } from 'react-router-dom';
import { CalendarDays, Download, ExternalLink, Pin } from 'lucide-react';
import type { Article } from '@/lib/types';
import { cn } from '@/lib/utils';
import SmartImage from './SmartImage';
import SpotlightCard from './SpotlightCard';

interface ArticleCardProps {
  article: Article;
  /** 紧凑模式：用于活动回顾等横向列表 */
  variant?: 'default' | 'compact';
  className?: string;
}

const splitTags = (tags: string) =>
  tags
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

/** 内容卡片：封面 + 标题 + 摘要 + 元信息，点击进入详情页 */
export function ArticleCard({
  article,
  variant = 'default',
  className,
}: ArticleCardProps) {
  const tags = splitTags(article.tags);
  const hasAttachment = !!(article.fileUrl || article.linkUrl);

  if (variant === 'compact') {
    return (
      <Link
        to={`/article/${article.id}`}
        className={cn(
          'group flex gap-4 rounded-xl border border-ink-900/[0.07] bg-white p-3 transition-all duration-300 ease-smooth hover:-translate-y-0.5 hover:border-flare-200 hover:shadow-card-hover',
          className
        )}
      >
        <div className='h-20 w-28 shrink-0 overflow-hidden rounded-lg'>
          <SmartImage
            src={article.cover}
            alt={article.title}
            seed={article.id}
            fallbackText='活动'
            className='h-full w-full transition-transform duration-700 ease-smooth group-hover:scale-105'
          />
        </div>
        <div className='min-w-0 flex-1'>
          <h3 className='line-clamp-2 text-sm font-semibold text-ink-900 transition-colors group-hover:text-flare-600'>
            {article.title}
          </h3>
          <p className='mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500'>
            {article.summary || article.subtitle}
          </p>
          {article.eventDate ? (
            <p className='num mt-2 flex items-center gap-1 text-xs text-ink-400'>
              <CalendarDays className='h-3 w-3' />
              {article.eventDate}
            </p>
          ) : null}
        </div>
      </Link>
    );
  }

  return (
    <SpotlightCard className={cn('h-full rounded-2xl', className)}>
      <Link
        to={`/article/${article.id}`}
        className='group relative flex h-full flex-col overflow-hidden rounded-2xl border border-ink-900/[0.07] bg-white shadow-card transition-all duration-500 ease-smooth hover:-translate-y-1.5 hover:border-flare-200 hover:shadow-card-hover'
      >
        <div className='relative h-44 overflow-hidden'>
          <SmartImage
            src={article.cover}
            alt={article.title}
            seed={article.id}
            fallbackText={article.title}
            className='h-full w-full transition-transform duration-700 ease-smooth group-hover:scale-[1.07]'
          />
          {article.pinned ? (
            <span className='absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-flare-500 px-2.5 py-1 text-xs font-medium text-white shadow-card'>
              <Pin className='h-3 w-3' />
              置顶
            </span>
          ) : null}
        </div>

        <div className='relative flex flex-1 flex-col p-5'>
          <h3 className='line-clamp-2 text-base font-semibold leading-snug text-ink-900 transition-colors group-hover:text-flare-600'>
            {article.title}
          </h3>
          {article.subtitle ? (
            <p className='mt-1.5 line-clamp-1 text-xs text-flare-600'>
              {article.subtitle}
            </p>
          ) : null}
          <p className='mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-ink-500'>
            {article.summary}
          </p>

          <div className='num mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400'>
            {article.eventDate ? (
              <span className='inline-flex items-center gap-1'>
                <CalendarDays className='h-3.5 w-3.5' />
                {article.eventDate}
              </span>
            ) : null}
            {article.author ? <span>{article.author}</span> : null}
            {hasAttachment ? (
              <span className='inline-flex items-center gap-1 text-flare-600'>
                {article.fileUrl ? (
                  <Download className='h-3.5 w-3.5' />
                ) : (
                  <ExternalLink className='h-3.5 w-3.5' />
                )}
                可下载
              </span>
            ) : null}
          </div>

          {tags.length ? (
            <div className='mt-3 flex flex-wrap gap-1.5'>
              {tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className='rounded-full border border-ink-900/[0.07] bg-ink-50 px-2 py-0.5 text-xs text-ink-500'
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {/* 底部渐显的高光边 */}
          <span
            aria-hidden
            className='pointer-events-none absolute inset-x-5 bottom-0 h-px origin-left scale-x-0 bg-gradient-to-r from-flare-400 to-transparent transition-transform duration-500 ease-smooth group-hover:scale-x-100'
          />
        </div>
      </Link>
    </SpotlightCard>
  );
}

export default ArticleCard;
