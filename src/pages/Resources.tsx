/**
 * 资料与数据。
 *
 * 数据来源：自建后端的 `/api/resources`（真实素材目录 `资料分享模块素材/` 已被扫描入库）。
 * 不再使用前端硬编码的内容条目 —— 那套东西与磁盘上的实际文件是对不上的。
 *
 * 分类与排序：
 * - 分类是**展示类目**（全部/电子书籍/数据/研报/课程资源），由后端按内容形态归集。
 *   注意它和磁盘目录不是一回事：文件存在「研发部内部资料」里，
 *   但只要内容是 epub，读者就应该在「电子书籍」标签下找到它。
 * - 公司 logo 属于首页展示素材，**不进本模块**（后端已按目录白名单排除）。
 * - 排序支持**按时间 / 按点赞数**切换，切换状态同步到 URL，便于分享与回退。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Clock,
  Flame,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import PageHero from '@/components/site/PageHero';
import Reveal from '@/components/site/Reveal';
import ResourceRow from '@/components/site/ResourceRow';
import {
  ALL_DISPLAY_CATEGORY,
  resourcesApi,
  ApiError,
  type ResourceCategory,
  type ResourceItem,
  type ResourceListResult,
  type ResourceSort,
} from '@/lib/backendApi';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * 展示类目的图标配色。键是**类目名**（不是磁盘目录名）。
 * 未匹配到用默认值，新增类目时不必同步改这里。
 */
export const CATEGORY_TONE: Record<string, string> = {
  电子书籍: 'border-brand-200 bg-brand-50 text-brand-700',
  数据: 'border-ink-900/10 bg-ink-50 text-ink-600',
  研报: 'border-flare-200 bg-flare-50 text-flare-700',
  课程资源: 'border-gold-200 bg-gold-50 text-gold-700',
};

export function Resources() {
  const { status: authStatus } = useAuth();
  const [params, setParams] = useSearchParams();

  const sort: ResourceSort = params.get('sort') === 'likes' ? 'likes' : 'time';
  /**
   * 当前展示类目。空串与「全部」等价 —— 都不按类目过滤。
   * 用 URL 承载，便于分享与后退。
   */
  const category = params.get('cat') ?? '';
  const [keyword, setKeyword] = useState('');

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [categories, setCategories] = useState<ResourceCategory[]>([]);
  const [summary, setSummary] = useState<ResourceListResult['summary']>();
  const [total, setTotal] = useState(0);
  /** 当前会话是否能看见受限条目（由后端裁决，前端不自行推断） */
  const [canViewRestricted, setCanViewRestricted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await resourcesApi.list({
        // 只取「资料与数据」模块 —— 社团成员产出自成一条产品线，
        // 有自己的页面与交互（作品卡片 / 详情页），不在此处混列。
        module: 'library',
        sort,
        displayCategory: category || undefined,
        pageSize: 500,
      });
      setItems(res.items);
      setCategories(res.categories);
      setSummary(res.summary);
      setTotal(res.total);
      setCanViewRestricted(res.canViewRestricted !== false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [sort, category]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 切换排序并写回 URL */
  const changeSort = (next: ResourceSort) => {
    const p = new URLSearchParams(params);
    if (next === 'time') p.delete('sort');
    else p.set('sort', next);
    setParams(p, { replace: true });
  };

  /** 切换类目并写回 URL（「全部」不写参数，保持链接干净） */
  const changeCategory = (next: string) => {
    const p = new URLSearchParams(params);
    if (!next || next === ALL_DISPLAY_CATEGORY) p.delete('cat');
    else p.set('cat', next);
    setParams(p, { replace: true });
  };

  /** 关键词在前端过滤：素材总量有限（几十条），无需为此加后端参数 */
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(kw) ||
        it.fileName.toLowerCase().includes(kw) ||
        // 同时搜磁盘目录与展示类目，两种叫法都找得到
        it.category.toLowerCase().includes(kw) ||
        (it.displayCategory ?? '').toLowerCase().includes(kw)
    );
  }, [items, keyword]);

  /** 点赞回调：同步父级数据，避免切换排序后数字回退 */
  const onLiked = (id: number, likes: number, liked: boolean) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, likes, liked } : it)));
  };

  /**
   * 「全部」的份数直接用后端 summary.total。
   *
   * 不要用 `categories.reduce(...)` —— 后端返回的 categories 首位就是
   * 「全部」聚合项，再累加会把「全部」重复计入，数字翻倍。
   */
  const totalFiles = summary?.total ?? categories.find((c) => c.aggregate)?.count ?? total;

  /**
   * 访客是否被裁掉了受限资料。
   *
   * 不显示具体份数：后端对访客只回可见条目的统计，前端拿不到全量做差集。
   * 硬凑一个数字不如只说「部分」——提示条的作用是告知而非精确计数。
   */
  const hasHiddenRestricted = authStatus === 'guest' && canViewRestricted === false && totalFiles > 0;

  return (
    <div>
      <PageHero
        kicker='resources & data'
        title='资料与数据'
        description='协会内部整理的培训资料、数据文件与模板。文件按分类归档，支持在线预览与下载。'
        aside={
          <span className='num rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card'>
            共 {String(totalFiles).padStart(2, '0')} 份
          </span>
        }
      />

      <section className='mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14'>
        {/* 工具条：分类 + 搜索 + 排序 */}
        <div className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center gap-2.5'>
            {categories.map((c) => {
              // 「全部」是聚合项：放首位，选中态对应「不带 cat 参数」
              const isAll = c.aggregate === true || c.category === ALL_DISPLAY_CATEGORY;
              const on = isAll ? category === '' : category === c.category;
              return (
                <button
                  key={c.category}
                  type='button'
                  onClick={() => changeCategory(isAll ? '' : c.category)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-smooth',
                    on
                      ? 'border-flare-200 bg-flare-50 text-flare-700 shadow-glow-flare'
                      : 'border-ink-900/10 bg-white text-ink-600 shadow-card hover:border-flare-200 hover:text-ink-900'
                  )}
                >
                  {c.category}
                  {c.count === 0 ? (
                    <span className='text-[10px] font-normal text-ink-300'>暂无</span>
                  ) : null}
                  <span
                    className={cn(
                      'num rounded-full px-1.5 text-xs',
                      on ? 'bg-flare-100 text-flare-700' : 'bg-ink-100 text-ink-400'
                    )}
                  >
                    {String(c.count).padStart(2, '0')}
                  </span>
                </button>
              );
            })}
          </div>

          <div className='flex flex-wrap items-center gap-3'>
            {/* 搜索 */}
            <div className='relative min-w-[14rem] flex-1 sm:max-w-xs'>
              <Search className='pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300' />
              <input
                type='text'
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder='搜索资料名称…'
                className='h-10 w-full rounded-lg border border-ink-900/10 bg-white pl-9 pr-3 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-brand-400'
              />
            </div>

            {/* 排序切换（右上角） */}
            <div className='ml-auto flex items-center gap-2'>
              <span className='hidden text-xs text-ink-400 sm:inline'>排序</span>
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
        </div>

        {/* 提示条：访客看到的是公开条目，内部资料已被服务端裁掉 */}
        {hasHiddenRestricted ? (
          <Reveal>
            <p className='mt-6 rounded-xl border border-gold-200 bg-gold-50 p-3.5 text-xs leading-relaxed text-gold-800'>
              部分内部资料仅对成员开放，登录后可见。
            </p>
          </Reveal>
        ) : null}

        {/* 列表 */}
        <div className='mt-7'>
          {loading && items.length === 0 ? (
            <div className='flex items-center gap-2 py-14 text-sm text-ink-400'>
              <Loader2 className='h-4 w-4 animate-spin' />
              正在加载资料列表…
            </div>
          ) : error ? (
            <div className='flex items-start gap-3 rounded-2xl border border-flare-200 bg-flare-50 p-5'>
              <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0 text-flare-600' />
              <div>
                <p className='text-sm font-medium text-flare-800'>无法加载资料列表</p>
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
                ? `没有匹配「${keyword}」的资料。`
                : category
                  ? `「${category}」下暂无资料。`
                  : '暂无资料。请检查素材目录是否已扫描入库。'}
            </div>
          ) : (
            <div className='space-y-3'>
              {visible.map((item, i) => (
                <Reveal key={item.id} delay={Math.min(i * 40, 320)}>
                  <ResourceRow item={item} onLiked={onLiked} />
                </Reveal>
              ))}
            </div>
          )}
        </div>

        {/* 底部统计 */}
        {!loading && !error && visible.length > 0 ? (
          <p className='num mt-6 text-center text-[11px] text-ink-400'>
            显示 {visible.length} / {total} 条
            {keyword ? `（关键词过滤自 ${items.length} 条）` : ''} · 排序：
            {sort === 'time' ? '按更新时间' : '按点赞数'}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export default Resources;
