import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarDays,
  Download,
  ExternalLink,
  User,
} from 'lucide-react';
import { useContent } from '@/lib/store';
import { CATEGORY_META } from '@/lib/types';
import SmartImage from '@/components/site/SmartImage';
import ArticleCard from '@/components/site/ArticleCard';
import Reveal from '@/components/site/Reveal';

/** 内容详情页 */
export function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const { articles, loading } = useContent();

  const article = useMemo(
    () => articles.find((a) => a.id === id),
    [articles, id]
  );

  const related = useMemo(() => {
    if (!article) return [];
    return articles
      .filter((a) => a.category === article.category && a.id !== article.id)
      .slice(0, 3);
  }, [articles, article]);

  if (loading) {
    return (
      <div className='mx-auto max-w-3xl px-4 py-24 text-center text-sm text-ink-400'>
        正在加载…
      </div>
    );
  }

  if (!article) {
    return (
      <div className='mx-auto max-w-3xl px-4 py-24 text-center'>
        <p className='text-lg font-semibold text-ink-900'>内容不存在或已下线</p>
        <Link
          to='/'
          className='group mt-5 inline-flex items-center gap-1 text-sm text-flare-600 transition-colors hover:text-flare-700'
        >
          <ArrowLeft className='h-4 w-4 transition-transform duration-300 group-hover:-translate-x-1' />
          返回首页
        </Link>
      </div>
    );
  }

  const tags = article.tags
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <article className='mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14'>
      <button
        type='button'
        onClick={() => window.history.back()}
        className='group inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-sm text-ink-600 shadow-card transition-colors hover:border-flare-200 hover:text-flare-600'
      >
        <ArrowLeft className='h-4 w-4 transition-transform duration-300 group-hover:-translate-x-1' />
        返回
      </button>

      <span className='mt-7 inline-block rounded-full border border-flare-200 bg-flare-50 px-3 py-1 text-xs font-medium text-flare-700'>
        {CATEGORY_META[article.category]?.label ?? '内容'}
      </span>

      <h1 className='text-gradient-ink mt-4 text-2xl font-bold leading-snug sm:text-4xl'>
        {article.title}
      </h1>
      {article.subtitle ? (
        <p className='mt-3 text-sm text-flare-600 sm:text-base'>
          {article.subtitle}
        </p>
      ) : null}

      <div className='num mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink-900/[0.07] pb-5 text-xs text-ink-400'>
        {article.eventDate ? (
          <span className='inline-flex items-center gap-1'>
            <CalendarDays className='h-3.5 w-3.5' />
            {article.eventDate}
          </span>
        ) : null}
        {article.author ? (
          <span className='inline-flex items-center gap-1'>
            <User className='h-3.5 w-3.5' />
            {article.author}
          </span>
        ) : null}
        {article.source ? <span>来源：{article.source}</span> : null}
      </div>

      {article.cover ? (
        <div className='ring-gradient mt-8 overflow-hidden rounded-2xl'>
          <SmartImage
            src={article.cover}
            alt={article.title}
            seed={article.id}
            className='max-h-[440px] w-full'
          />
        </div>
      ) : null}

      {article.summary ? (
        <p className='mt-8 rounded-xl border-l-2 border-flare-400 bg-flare-50/60 p-4 text-sm leading-relaxed text-ink-600'>
          {article.summary}
        </p>
      ) : null}

      <div className='mt-8 space-y-4 text-sm leading-8 text-ink-700 sm:text-base'>
        {article.content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line, i) => (
            <p key={i}>{line}</p>
          ))}
      </div>

      {article.fileUrl || article.linkUrl ? (
        <div className='mt-10 flex flex-wrap gap-3'>
          {article.fileUrl ? (
            <a
              href={article.fileUrl}
              target='_blank'
              rel='noreferrer'
              className='group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-flare-500 to-flare-600 px-5 py-2.5 text-sm font-semibold text-white shadow-glow-flare transition-all duration-300 ease-smooth hover:brightness-110'
            >
              <Download className='h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5' />
              下载附件 / 资料
            </a>
          ) : null}
          {article.linkUrl ? (
            <a
              href={article.linkUrl}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-2 rounded-lg border border-ink-900/12 bg-white px-5 py-2.5 text-sm font-medium text-ink-700 shadow-card transition-all duration-300 ease-smooth hover:border-flare-300 hover:text-flare-600'
            >
              <ExternalLink className='h-4 w-4' />
              访问外部链接
            </a>
          ) : null}
        </div>
      ) : null}

      {tags.length ? (
        <div className='mt-8 flex flex-wrap gap-2'>
          {tags.map((tag) => (
            <span
              key={tag}
              className='rounded-full border border-ink-900/[0.07] bg-ink-50 px-3 py-1 text-xs text-ink-500'
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {related.length ? (
        <div className='mt-16 border-t border-ink-900/[0.07] pt-10'>
          <h2 className='flex items-center gap-3 text-lg font-semibold text-ink-900'>
            <span className='h-5 w-0.5 rounded-full bg-gradient-to-b from-flare-500 to-gold-500' />
            相关内容
          </h2>
          <div className='mt-6 grid gap-6 sm:grid-cols-3'>
            {related.map((a, i) => (
              <Reveal key={a.id} delay={i * 90}>
                <ArticleCard article={a} />
              </Reveal>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default ArticleDetail;
