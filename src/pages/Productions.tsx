/**
 * 社团成员产出。
 *
 * 数据源：后端 `/api/resources?module=productions` —— 作品与资料共用一张表，
 * 由后端按展示类目分流；本页只负责「作品视角」的渲染。
 *
 * 为什么不用 `useContent()` 的文章数据：
 * 产出的主体是**文件作品**（尽调资料包、每日新闻整理稿、研究报告），
 * 它们有体积、可下载、可点赞、有作者与截图 —— 文章模型承载不了这些属性。
 * 原有的文章型内容（协会刊物等）仍以「协会出版物」小节保留，避免内容凭空消失。
 *
 * 排序：按时间 / 按点赞，状态写进 URL（`?sort=likes`），便于分享与回退。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Award, Clock, Flame, Loader2, RefreshCw, Search } from 'lucide-react';
import PageHero from '@/components/site/PageHero';
import ArticleCard from '@/components/site/ArticleCard';
import Reveal from '@/components/site/Reveal';
import WorkCard from '@/components/site/WorkCard';
import { ApiError, resourcesApi, type ResourceItem, type ResourceSort } from '@/lib/backendApi';
import { useAuth } from '@/lib/auth';
import { useContent } from '@/lib/store';
import { cn } from '@/lib/utils';

/** 与后端 SORTS 白名单一致；`time` 即「按上传时间倒序」 */
const SORT_LABEL: Record<ResourceSort, string> = { time: '按时间', likes: '按点赞' };

export function Productions() {
  const { status: authStatus } = useAuth();
  const { articles } = useContent();
  const [params, setParams] = useSearchParams();

  const sort: ResourceSort = params.get('sort') === 'likes' ? 'likes' : 'time';
  const [keyword, setKeyword] = useState('');

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await resourcesApi.list({
        module: 'productions',
        sort,
        pageSize: 300,
      });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [sort]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeSort = (next: ResourceSort) => {
    const p = new URLSearchParams(params);
    if (next === 'time') p.delete('sort');
    else p.set('sort', next);
    setParams(p, { replace: true });
  };

  /** 关键词在前端过滤：作品总量很小，不必为此加后端参数 */
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) =>
      [it.name, it.fileName, it.summary, it.author, it.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(kw)
    );
  }, [items, keyword]);

  /** 点赞后同步本地数据，避免切排序时数字回退 */
  const onLiked = (id: number, likes: number, liked: boolean) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, likes, liked } : it)));
  };

  /** 文章型的协会出版物：与文件作品并列展示，不参与排序 */
  const publications = useMemo(
    () => articles.filter((a) => a.category === 'production'),
    [articles]
  );

  /** 访客被裁掉受限作品时给一句提示（不显示份数：后端不会下发全量做差集） */
  const hasHidden = authStatus === 'guest';

  return (
    <div>
      <PageHero
        kicker='our works'
        title='社团成员产出'
        description='协会成员自己动手做出来的东西：公司尽调资料包、每日新闻整理、专题研究与估值报告。每一件都标注了作者与用途，欢迎下载、分享与点赞。'
        aside={
          <span className='num rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card'>
            {loading ? '--' : String(visible.length).padStart(2, '0')} 件
          </span>
        }
      />

      <section className='mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14'>
        <Reveal>
          <div className='mb-7 flex items-start gap-3 rounded-2xl border border-gold-200 bg-gold-50 p-4'>
            <Award className='mt-0.5 h-5 w-5 shrink-0 text-gold-600' />
            <p className='text-sm leading-relaxed text-gold-800'>
              以下成果由协会成员共同完成，版权归协会与作者所有，仅供校内学习交流使用，请勿外传或用于商业用途。
            </p>
          </div>
        </Reveal>

        {/* 工具条：搜索 + 排序 */}
        <div className='flex flex-wrap items-center gap-3'>
          <div className='relative min-w-[14rem] flex-1 sm:max-w-xs'>
            <Search className='pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300' />
            <input
              type='text'
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder='搜索作品名称、作者或标签…'
              className='h-10 w-full rounded-lg border border-ink-900/10 bg-white pl-9 pr-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
            />
          </div>

          <div className='ml-auto flex items-center gap-2'>
            <span className='hidden text-xs text-ink-400 sm:inline'>排序</span>
            <div className='inline-flex overflow-hidden rounded-lg border border-ink-900/10 bg-white'>
              {(['time', 'likes'] as const).map((key) => (
                <button
                  key={key}
                  type='button'
                  onClick={() => changeSort(key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                    key === 'likes' && 'border-l border-ink-900/10',
                    sort === key
                      ? 'bg-flare-50 text-flare-700'
                      : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
                  )}
                >
                  {key === 'time' ? (
                    <Clock className='h-3.5 w-3.5' />
                  ) : (
                    <Flame className='h-3.5 w-3.5' />
                  )}
                  {SORT_LABEL[key]}
                </button>
              ))}
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

        {hasHidden ? (
          <Reveal>
            <p className='mt-6 rounded-xl border border-gold-200 bg-gold-50 p-3.5 text-xs leading-relaxed text-gold-800'>
              部分作品仅对成员开放，登录后可见。
            </p>
          </Reveal>
        ) : null}

        {/* 作品列表 */}
        <div className='mt-7'>
          {loading && items.length === 0 ? (
            <div className='flex items-center gap-2 py-14 text-sm text-ink-400'>
              <Loader2 className='h-4 w-4 animate-spin' />
              正在载入作品列表…
            </div>
          ) : error ? (
            <div className='flex items-start gap-3 rounded-2xl border border-flare-200 bg-flare-50 p-5'>
              <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0 text-flare-600' />
              <div>
                <p className='text-sm font-medium text-flare-800'>无法加载作品列表</p>
                <p className='mt-1 text-xs leading-relaxed text-flare-700'>{error}</p>
                <p className='mt-2 text-xs text-flare-600'>
                  本地开发时请在 <code className='rounded bg-flare-100 px-1.5 py-0.5'>server/</code>{' '}
                  目录执行 <code className='rounded bg-flare-100 px-1.5 py-0.5'>npm start</code>
                </p>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-ink-900/12 bg-white/60 px-6 py-14 text-center text-sm text-ink-400'>
              {keyword
                ? `没有匹配「${keyword}」的作品。`
                : '暂无作品。可把作品文件放进素材目录后重新扫描，或在 server/data/production-meta.json 中补齐作者与简介。'}
            </div>
          ) : (
            <div className='grid gap-6 sm:grid-cols-2 lg:grid-cols-3'>
              {visible.map((item, i) => (
                <Reveal key={item.id} delay={Math.min(i * 70, 420)}>
                  <WorkCard item={item} onLiked={onLiked} />
                </Reveal>
              ))}
            </div>
          )}
        </div>

        {/* 文章型的协会出版物：与文件作品互补，不参与上面的排序 */}
        {publications.length ? (
          <div className='mt-14'>
            <div className='mb-5 flex items-center gap-3'>
              <h2 className='text-lg font-semibold text-ink-900'>协会出版物与合集</h2>
              <span className='num rounded-full border border-ink-900/10 bg-white px-2 py-0.5 text-[11px] text-ink-500'>
                {String(publications.length).padStart(2, '0')}
              </span>
            </div>
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {publications.map((a, i) => (
                <Reveal key={a.id} delay={Math.min(i * 60, 300)}>
                  {/* ArticleCard 自身已含 <Link>，这里不要再包一层，否则是嵌套 <a> */}
                  <ArticleCard article={a} />
                </Reveal>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default Productions;
