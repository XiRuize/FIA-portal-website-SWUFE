/**
 * 作品卡片：社团成员产出的**大框**。
 *
 * 形态参考内容卡片（ArticleCard）：封面区 + 标题 + 摘要 + 元信息，整块可点。
 * 与 ArticleCard 的两点关键差异：
 * 1. **封面不是真实图片**。作品是 PDF / 压缩包，没有配图；这里按「有截图用截图、
 *    是图片直接用文件、其余用类型化的占位面板」三级降级，避免一整片灰底破图。
 * 2. **点赞按钮不能嵌在链接里**。整块是 `<Link>`，而点赞是另一个交互，
 *    因此把操作条放在链接**之外**（同级），否则要么 HTML 非法、要么点个赞就跳页。
 */
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, Heart, Lock, Share2 } from 'lucide-react';
import type { ResourceItem } from '@/lib/backendApi';
import { resourcesApi } from '@/lib/backendApi';
import {
  relativeTime,
  shareResource,
  useResourceLike,
} from '@/lib/resourceActions';
import { cn } from '@/lib/utils';
import ResourceGlyph, { isImageExt, labelForExt } from './ResourceGlyph';
import SpotlightCard from './SpotlightCard';

interface Props {
  item: ResourceItem;
  /** 点赞后回传，保证列表数字与服务端一致（切排序时不回退） */
  onLiked?: (id: number, likes: number, liked: boolean) => void;
}

export function WorkCard({ item, onLiked }: Props) {
  const { likes, liked, busy, toggle } = useResourceLike(item, onLiked);
  const restricted = item.accessLevel === 'member';
  const cover = item.screenshots[0]?.url ?? (isImageExt(item.ext) ? resourcesApi.previewUrl(item.id) : '');

  return (
    <SpotlightCard className='h-full rounded-2xl'>
      <div className='flex h-full flex-col overflow-hidden rounded-2xl border border-ink-900/[0.07] bg-white shadow-card transition-all duration-500 ease-smooth hover:-translate-y-1.5 hover:border-flare-200 hover:shadow-card-hover'>
        <Link to={`/production/${item.id}`} className='group flex flex-1 flex-col'>
          {/* 封面区 */}
          <div className='relative h-44 overflow-hidden bg-ink-50'>
            {cover ? (
              <img
                src={cover}
                alt={item.name}
                loading='lazy'
                className='h-full w-full object-cover transition-transform duration-700 ease-smooth group-hover:scale-[1.07]'
              />
            ) : (
              /* 无截图时的类型化占位：大图标 + 文件名，比一张灰底破图更有信息量 */
              <div className='flex h-full w-full flex-col items-center justify-center gap-2.5 bg-gradient-to-br from-flare-50 via-white to-ink-50 px-6'>
                <ResourceGlyph ext={item.ext} className='h-14 w-14 rounded-xl' iconClassName='h-7 w-7' />
                <span className='num max-w-full truncate text-[11px] text-ink-400' title={item.fileName}>
                  {item.fileName}
                </span>
              </div>
            )}

            {/* 角标：作品类型 */}
            <span className='absolute left-3 top-3 inline-flex items-center gap-1 rounded-full border border-flare-200 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-flare-700 shadow-card'>
              {labelForExt(item.ext)} 作品
            </span>

            {restricted ? (
              <span className='absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-gold-200 bg-gold-50/95 px-2 py-1 text-[10px] text-gold-700 shadow-card'>
                <Lock className='h-2.5 w-2.5' />
                仅成员
              </span>
            ) : null}
          </div>

          {/* 正文 */}
          <div className='relative flex flex-1 flex-col p-5'>
            <h3 className='line-clamp-2 text-base font-semibold leading-snug text-ink-900 transition-colors group-hover:text-flare-600'>
              {item.name}
            </h3>

            {/* 作者行：作品的「人味」都在这 */}
            <p className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500'>
              <span className='font-medium text-ink-700'>{item.author || '作者待补充'}</span>
              {item.authorTitle ? (
                <span className='text-ink-400'>· {item.authorTitle}</span>
              ) : null}
            </p>

            <p className='mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-ink-500'>
              {item.summary || '作品简介待补充。'}
            </p>

            {item.tags.length ? (
              <div className='mt-3 flex flex-wrap gap-1.5'>
                {item.tags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className='rounded-full border border-ink-900/[0.07] bg-ink-50 px-2 py-0.5 text-xs text-ink-500'
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <div className='num mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400'>
              <span>{relativeTime(item.uploadedAt)}</span>
              <span>{item.sizeText}</span>
              <span className='inline-flex items-center gap-1 text-flare-600'>
                <Download className='h-3.5 w-3.5' />
                可下载
              </span>
            </div>

            <span
              aria-hidden
              className='pointer-events-none absolute inset-x-5 bottom-0 h-px origin-left scale-x-0 bg-gradient-to-r from-flare-400 to-transparent transition-transform duration-500 ease-smooth group-hover:scale-x-100'
            />
          </div>
        </Link>

        {/* 操作条：刻意放在 <Link> 之外，避免「点赞即跳页」 */}
        <div className='flex items-center gap-2 border-t border-ink-900/[0.07] bg-ink-50/50 px-5 py-3'>
          <button
            type='button'
            onClick={() => void toggle()}
            disabled={busy}
            title={liked ? '取消点赞' : '点赞'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-200',
              liked
                ? 'border-flare-200 bg-flare-50 text-flare-600'
                : 'border-ink-900/10 bg-white text-ink-500 hover:border-flare-200 hover:text-flare-600',
              busy && 'opacity-60'
            )}
          >
            <Heart className={cn('h-3.5 w-3.5', liked && 'fill-current')} />
            <span className='num tabular-nums'>{likes}</span>
          </button>

          <button
            type='button'
            onClick={() => void shareResource(item, `${window.location.origin}/#/production/${item.id}`)}
            title='分享作品链接'
            className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-500 transition-colors hover:border-brand-300 hover:text-brand-700'
          >
            <Share2 className='h-3.5 w-3.5' />
            分享
          </button>

          <Link
            to={`/production/${item.id}`}
            className='ml-auto inline-flex items-center gap-1 text-xs font-medium text-flare-600 transition-colors hover:text-flare-700'
          >
            查看作品
            <ArrowUpRight className='h-3.5 w-3.5' />
          </Link>
        </div>
      </div>
    </SpotlightCard>
  );
}

export default WorkCard;
