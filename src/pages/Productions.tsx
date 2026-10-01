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
 * ## 两层筛选，方向不同
 *
 * - **横向**是**部门**（研发部 / 培训部 / 宣传中心）：读者关心「哪个部门做的」，
 *   这是产出页特有的组织方式，资料页没有这一层。
 * - **纵向**是**排序**（按时间 / 按点赞）。
 *
 * ⚠️ 部门**不是**展示类目。展示类目（电子书籍/数据/研报/课程资源/社团成员产出）
 * 决定一条记录属于哪个**模块**，是后端 `moduleScope()` 做数据隔离的依据；
 * 若把部门塞进展示类目体系，「全部 = 各类之和」的口径会崩，两个页面还会串台。
 * 因此部门走独立的 `department` 查询参数，取值允许为空。
 *
 * 排序与部门筛选的状态都写进 URL（`?dept=研发部&sort=likes`），便于分享与回退。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Award, Clock, Flame, Loader2, RefreshCw, Search } from 'lucide-react';
import PageHero from '@/components/site/PageHero';
import ArticleCard from '@/components/site/ArticleCard';
import Reveal from '@/components/site/Reveal';
import WorkCard from '@/components/site/WorkCard';
import {
  ApiError,
  resourcesApi,
  type ResourceDepartment,
  type ResourceItem,
  type ResourceSort,
} from '@/lib/backendApi';
import { useAuth } from '@/lib/auth';
import { useContent } from '@/lib/store';
import { cn } from '@/lib/utils';

/** 与后端 SORTS 白名单一致；`time` 即「按上传时间倒序」 */
const SORT_LABEL: Record<ResourceSort, string> = { time: '按时间', likes: '按点赞' };

/** 「全部」部门的展示名。与后端 `ALL_CATEGORY` 同值，用于「不带 dept 参数」的语义 */
const ALL_DEPARTMENT = '全部';

/**
 * 部门标签的统一配色。
 *
 * 用单一色系而非一部门一色：部门是**筛选维度**不是**分类归属**，
 * 给每个部门配一种颜色会让人误以为它和展示类目是同一层级的东西。
 * 选中态用主色（flare）与排序按钮的选中态保持一致，读者一眼能看出
 * 「这两个控件都是筛选器」。
 */
const DEPT_TONE = {
  base: 'border-ink-900/10 bg-white text-ink-600 shadow-card hover:border-flare-200 hover:text-ink-900',
  active: 'border-flare-200 bg-flare-50 text-flare-700 shadow-glow-flare',
} as const;

export function Productions() {
  const { status: authStatus } = useAuth();
  const { articles } = useContent();
  const [params, setParams] = useSearchParams();

  const sort: ResourceSort = params.get('sort') === 'likes' ? 'likes' : 'time';
  /** 当前部门；空串与「全部」等价 —— 都不按部门过滤 */
  const department = params.get('dept') ?? '';
  const [keyword, setKeyword] = useState('');

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [departments, setDepartments] = useState<ResourceDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await resourcesApi.list({
        module: 'productions',
        sort,
        department: department || undefined,
        pageSize: 300,
      });
      setItems(res.items);
      // 部门清单由后端按「产出模块 + 当前可见性」裁定，前端不自行统计
      setDepartments(res.departments ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
      setDepartments([]);
    } finally {
      setLoading(false);
    }
  }, [sort, department]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeSort = (next: ResourceSort) => {
    const p = new URLSearchParams(params);
    if (next === 'time') p.delete('sort');
    else p.set('sort', next);
    setParams(p, { replace: true });
  };

  /** 切换部门并写回 URL（「全部」不写参数，保持链接干净） */
  const changeDepartment = (next: string) => {
    const p = new URLSearchParams(params);
    if (!next || next === ALL_DEPARTMENT) p.delete('dept');
    else p.set('dept', next);
    setParams(p, { replace: true });
  };

  /** 关键词在前端过滤：作品总量很小，不必为此加后端参数 */
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) =>
      [it.name, it.fileName, it.summary, it.author, it.department, it.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(kw)
    );
  }, [items, keyword]);

  /**
   * 「全部」下的作品总数。
   *
   * 不在前端把各部门份数相加：那样会把**未标部门**的作品漏掉
   * （它们计入「全部」但不进任何部门标签），总数就会比实际少。
   * 后端 `departments` 只回具体部门，不含「全部」聚合项。
   *
   * 注意：当前选中某个部门时 `items` 已被后端裁到该部门，
   * 此时取不到「全部」的真实总数 —— 因此仅在未筛选时用作总数显示。
   */
  const totalAll = useMemo(
    () => departments.reduce((sum, d) => sum + d.count, 0),
    [departments]
  );

  /** 点赞后同步本地数据，避免切排序时数字回退 */
  const onLiked = (id: number, likes: number, liked: boolean) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, likes, liked } : it)));
  };

  /** 文章型的协会出版物：与文件作品并列展示，不参与排序与部门筛选 */
  const publications = useMemo(
    () => articles.filter((a) => a.category === 'production'),
    [articles]
  );

  /** 访客被裁掉受限作品时给一句提示（不显示份数：后端不会下发全量做差集） */
  const hasHidden = authStatus === 'guest';

  /**
   * 作品总件数（英雄区右上角）。
   *
   * 未筛选时用后端回的各部门之和；筛选状态下 items 已是子集，
   * 就直接用当前列表长度 —— 这样显示的数字**始终等于下面能看到的东西**，
   * 不会出现「角上写 06 件、页面里只有 1 件」的困惑。
   */
  const shownCount = department ? visible.length : Math.max(totalAll, visible.length);

  return (
    <div>
      <PageHero
        kicker='our works'
        title='社团成员产出'
        description='协会成员自己动手做出来的东西：公司尽调资料包、每日新闻整理、专题研究与估值报告。每一件都标注了作者与用途，欢迎下载、分享与点赞。'
        aside={
          <span className='num rounded-lg border border-ink-900/10 bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card'>
            {loading ? '--' : String(shownCount).padStart(2, '0')} 件
          </span>
        }
      />

      <section className='mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14'>
        {/* 部门导航：产出页特有的组织方式，让读者按「哪个部门做的」挑作品 */}
        <Reveal>
          <nav aria-label='按部门筛选作品' className='mb-5 flex flex-wrap items-center gap-2.5'>
            {[
              { key: ALL_DEPARTMENT, count: totalAll },
              ...departments.map((d) => ({ key: d.department, count: d.count })),
            ].map((item) => {
              const isAll = item.key === ALL_DEPARTMENT;
              const on = isAll ? department === '' : department === item.key;
              return (
                <button
                  key={item.key}
                  type='button'
                  onClick={() => changeDepartment(isAll ? '' : item.key)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-smooth',
                    on ? DEPT_TONE.active : DEPT_TONE.base
                  )}
                >
                  {item.key}
                  {item.count === 0 ? (
                    <span className='text-[10px] font-normal text-ink-300'>暂无</span>
                  ) : null}
                  <span
                    className={cn(
                      'num rounded-full px-1.5 text-xs',
                      on ? 'bg-flare-100 text-flare-700' : 'bg-ink-100 text-ink-400'
                    )}
                  >
                    {String(item.count).padStart(2, '0')}
                  </span>
                </button>
              );
            })}
          </nav>
        </Reveal>

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
                ? `没有匹配「${keyword}」的作品${department ? `（${department}）` : ''}。`
                : department
                  ? `${department}暂无作品。可切换到其他部门，或查看「全部」。`
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
