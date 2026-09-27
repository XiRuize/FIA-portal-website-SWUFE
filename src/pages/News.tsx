/**
 * 财经时事。
 *
 * 页面结构（自上而下，按「先看行情、再看资讯」的信息优先级排布）：
 *   1. **行情看板** —— 首屏即见，股票池快照 + 蜡烛图 + 区间/均线切换；
 *   2. **日期切换条** —— 归档保留一周，点击任意日期查看当日十条资讯；
 *   3. **当日资讯列表** —— 点击标题在新标签页打开**原文**，不做站内转载。
 *
 * 为什么把看板放最上面：读者打开「财经时事」的第一诉求是「现在市场怎么样」，
 * 而不是「昨天发生了什么」。资讯列表自然下移到折叠线以下，
 * 滑动即可看到，符合从概览到细节的阅读顺序。
 *
 * 数据来源：自建后端 `/api/news/daily`（东方财富系信源），
 * 每日 10 条，按日期分桶归档；历史日期只读缓存，不触发抓取。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  Clock,
  Flame,
  Heart,
  Loader2,
  Newspaper,
  RefreshCw,
} from 'lucide-react';
import { ApiError, newsApi, type NewsArchiveDate, type NewsItem } from '@/lib/backendApi';
import { cn } from '@/lib/utils';
import { StockBoard } from '@/components/site/StockBoard';

/** 把 YYYY-MM-DD 渲染成「09-26」 */
const shortDate = (iso: string) => (iso.length >= 10 ? iso.slice(5) : iso);

/** 把 YYYY-MM-DD 渲染成「9月26日 周六」 */
function friendlyDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso || '—';
  const [, y, mo, d] = m;
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(Number(y), Number(mo) - 1, Number(d)).getDay()
  ];
  return `${Number(mo)}月${Number(d)}日 ${week}`;
}

/** 单条时事 */
function NewsRow({
  item,
  index,
  onLiked,
}: {
  item: NewsItem;
  index: number;
  onLiked: (id: number, likes: number, liked: boolean) => void;
}) {
  const [likes, setLikes] = useState(item.likes);
  const [liked, setLiked] = useState(item.liked);
  const [busy, setBusy] = useState(false);

  const toggleLike = async () => {
    if (busy) return;
    const nextLiked = !liked;
    setLiked(nextLiked);
    setLikes((n) => Math.max(0, n + (nextLiked ? 1 : -1)));
    setBusy(true);
    try {
      const res = nextLiked ? await newsApi.like(item.id) : await newsApi.unlike(item.id);
      setLikes(res.likes);
      setLiked(res.liked);
      onLiked(item.id, res.likes, res.liked);
    } catch {
      // 失败回滚
      setLiked(liked);
      setLikes(item.likes);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='group flex items-start gap-4 border-b border-ink-900/[0.07] py-4 last:border-0'>
      {/* 序号 */}
      <span className='num mt-0.5 w-6 shrink-0 text-xs text-ink-300 tabular-nums'>
        {String(index + 1).padStart(2, '0')}
      </span>

      {/* 主体：标题即外链 */}
      <div className='min-w-0 flex-1'>
        <a
          href={item.url}
          target='_blank'
          rel='noopener noreferrer'
          className='group/link inline-flex items-start gap-1.5 text-sm font-medium leading-relaxed text-ink-900 transition-colors hover:text-brand-700'
        >
          <span>{item.title}</span>
          <ArrowUpRight className='mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300 transition-colors group-hover/link:text-brand-500' />
        </a>

        <div className='mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400'>
          <span className='inline-flex items-center gap-1'>
            <Clock className='h-3 w-3' />
            {item.publishedAt ? item.publishedAt.slice(11, 16) : '—'}
          </span>
          {item.source ? <span>{item.source}</span> : null}
        </div>
      </div>

      {/* 点赞 */}
      <button
        type='button'
        onClick={() => void toggleLike()}
        disabled={busy}
        title={liked ? '取消点赞' : '点赞'}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-200',
          liked
            ? 'border-flare-200 bg-flare-50 text-flare-600'
            : 'border-ink-900/10 bg-white text-ink-400 hover:border-flare-200 hover:text-flare-600',
          busy && 'opacity-60'
        )}
      >
        <Heart className={cn('h-3.5 w-3.5', liked && 'fill-current')} />
        <span className='num tabular-nums'>{likes}</span>
      </button>
    </div>
  );
}

export function News() {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') === 'likes' ? 'likes' : 'time';
  const dateParam = params.get('date') ?? '';

  const [items, setItems] = useState<NewsItem[]>([]);
  const [bucketDate, setBucketDate] = useState('');
  const [archive, setArchive] = useState<NewsArchiveDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // 指定日期时后端只读归档、不触发抓取；省略则取当日
      const res = await newsApi.daily(10, dateParam || undefined);
      setItems(res.items);
      setBucketDate(res.date);
      if (res.dates?.length) setArchive(res.dates);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [dateParam]);

  useEffect(() => {
    void load();
  }, [load]);

  // 单独取一次归档列表：首次进入时即使当天抓取失败，日期条也要能显示
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await newsApi.dates();
        if (!cancelled && res.dates?.length) setArchive(res.dates);
      } catch {
        // 归档列表拿不到不影响正文，静默即可
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const changeSort = (next: 'time' | 'likes') => {
    const p = new URLSearchParams(params);
    if (next === 'time') p.delete('sort');
    else p.set('sort', next);
    setParams(p, { replace: true });
  };

  /** 切换日期。用 push 而非 replace，让浏览器后退键能回到上一天 */
  const changeDate = (next: string) => {
    const p = new URLSearchParams(params);
    if (!next || next === archive[0]?.date) p.delete('date');
    else p.set('date', next);
    setParams(p);
  };

  /** 按点赞排序时，同点赞数保持时间顺序（稳定排序） */
  const sorted = useMemo(() => {
    if (sort === 'time') return items;
    return [...items].sort((a, b) => b.likes - a.likes);
  }, [items, sort]);

  const onLiked = (id: number, likes: number, liked: boolean) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, likes, liked } : it)));
  };

  return (
    <div>
      <section className='relative border-b border-ink-900/[0.07]'>
        <div className='mx-auto max-w-6xl px-4 pb-8 pt-14 sm:px-6 sm:pt-20'>
          <p className='num mb-4 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-flare-500'>
            <span className='inline-block h-px w-8 bg-flare-300' />
            financial briefing
          </p>
          <h1 className='text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl'>
            财经时事
          </h1>
          <p className='mt-4 max-w-2xl text-sm leading-relaxed text-ink-500'>
            上方为实时行情看板，向下滑动查看每日十条财经要闻。资讯按天归档、保留一周，可点击日期切换。
            点击标题在新窗口打开原文。
          </p>
        </div>
      </section>

      {/* ── 1. 行情看板：首屏即见 ───────────────────────────────── */}
      <section className='border-b border-ink-900/[0.07] bg-gradient-to-b from-white to-ink-50/60'>
        <div className='mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10'>
          <StockBoard />
        </div>
      </section>

      {/* ── 2. 每日资讯：需向下滑动 ─────────────────────────────── */}
      <section className='mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14'>
        <div className='mb-6 flex flex-wrap items-end justify-between gap-3'>
          <div>
            <h2 className='flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-900'>
              <Newspaper className='h-4 w-4 text-flare-500' />
              每日要闻
            </h2>
            <p className='mt-1 text-xs text-ink-400'>
              {friendlyDate(bucketDate)}
              {archive.length > 1 ? ` · 归档保留最近 ${archive.length} 天` : ''}
            </p>
          </div>

          <div className='flex items-center gap-2'>
            <div className='inline-flex overflow-hidden rounded-lg border border-ink-900/10 bg-white'>
              <button
                type='button'
                onClick={() => changeSort('time')}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                  sort === 'time'
                    ? 'bg-flare-50 text-flare-700'
                    : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
                )}
              >
                <Clock className='h-3.5 w-3.5' />
                按时间
              </button>
              <button
                type='button'
                onClick={() => changeSort('likes')}
                className={cn(
                  'inline-flex items-center gap-1.5 border-l border-ink-900/10 px-3 py-2 text-xs font-medium transition-colors',
                  sort === 'likes'
                    ? 'bg-flare-50 text-flare-700'
                    : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
                )}
              >
                <Flame className='h-3.5 w-3.5' />
                按点赞
              </button>
            </div>

            <button
              type='button'
              onClick={() => void load()}
              disabled={loading}
              title='重新加载'
              className='inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-xs font-medium text-ink-500 transition-colors hover:text-ink-800 disabled:opacity-50'
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* 日期切换条 */}
        {archive.length > 0 ? (
          <div className='mb-6 flex flex-wrap items-center gap-2'>
            <span className='inline-flex items-center gap-1.5 text-[11px] text-ink-400'>
              <CalendarDays className='h-3.5 w-3.5' />
              选择日期
            </span>
            {archive.map((d, i) => {
              // 第一个是最新一天；未带 date 参数时即选中它
              const active = dateParam ? d.date === dateParam : i === 0;
              return (
                <button
                  key={d.date}
                  type='button'
                  onClick={() => changeDate(d.date)}
                  title={`${d.date} · ${d.count} 条`}
                  className={cn(
                    'num inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-200',
                    active
                      ? 'border-flare-300 bg-flare-50 font-semibold text-flare-700'
                      : 'border-ink-900/10 bg-white text-ink-500 hover:border-flare-200 hover:text-flare-600'
                  )}
                >
                  {shortDate(d.date)}
                  <span
                    className={cn(
                      'rounded px-1 text-[10px] tabular-nums',
                      active ? 'bg-flare-100 text-flare-600' : 'bg-ink-100 text-ink-400'
                    )}
                  >
                    {d.count}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* 列表 */}
        {loading && items.length === 0 ? (
          <div className='flex items-center gap-2 py-14 text-sm text-ink-400'>
            <Loader2 className='h-4 w-4 animate-spin' />
            正在获取当日财经时事…
          </div>
        ) : error ? (
          <div className='flex items-start gap-3 rounded-2xl border border-flare-200 bg-flare-50 p-5'>
            <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0 text-flare-600' />
            <div>
              <p className='text-sm font-medium text-flare-800'>无法加载财经时事</p>
              <p className='mt-1 text-xs leading-relaxed text-flare-700'>{error}</p>
              <p className='mt-2 text-xs text-flare-600'>
                首次抓取需要联网。若后端未启动，请在{' '}
                <code className='rounded bg-flare-100 px-1.5 py-0.5'>server/</code> 目录执行{' '}
                <code className='rounded bg-flare-100 px-1.5 py-0.5'>npm start</code>
              </p>
            </div>
          </div>
        ) : sorted.length === 0 ? (
          <div className='rounded-2xl border border-dashed border-ink-900/12 bg-white/60 px-6 py-14 text-center text-sm text-ink-400'>
            {dateParam
              ? `${friendlyDate(dateParam)} 无归档条目，可能已超出保留天数。`
              : '暂无当日条目。后端会每日自动抓取，稍后再试。'}
          </div>
        ) : (
          <div className='rounded-2xl border border-ink-900/10 bg-white px-5 py-2 shadow-card sm:px-6'>
            {sorted.map((item, i) => (
              <NewsRow key={item.id} item={item} index={i} onLiked={onLiked} />
            ))}
          </div>
        )}

        {!loading && !error && sorted.length > 0 ? (
          <p className='mt-5 text-center text-[11px] text-ink-400'>
            共 {sorted.length} 条 · 排序：{sort === 'time' ? '按发布时间' : '按点赞数'} · 点击标题跳转原文
          </p>
        ) : null}
      </section>
    </div>
  );
}

export default News;
