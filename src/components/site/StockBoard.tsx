import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Activity,
  Info,
  Loader2,
  RefreshCw,
  Search,
  SignalHigh,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useContent } from '@/lib/store';
import { getSetting, parseWatchlist } from '@/lib/siteConfig';
import {
  DEFAULT_STOCK_BASE,
  MA_COLORS,
  MA_WINDOWS,
  RANGE_OPTIONS,
  SEARCH_DEBOUNCE_MS,
  computeMetrics,
  fetchKlines,
  resetStockCache,
  searchSymbols,
  sliceRange,
  type BoardData,
  type RangeOption,
  type SymbolHit,
} from '@/lib/stockApi';
import { useQuotes } from '@/lib/useQuotes';
import { cn } from '@/lib/utils';
import BorderBeam from './BorderBeam';
import CandleChart from './CandleChart';
import Marquee from './Marquee';
import Reveal from './Reveal';
import Sparkline from './Sparkline';

/** 自动刷新间隔 */
const AUTO_REFRESH_MS = 60_000;
/**
 * 统一按最大区间取数，区间切换只在客户端切片。
 * 好处：股票池行情条、迷你走势与主图共用同一份缓存，避免重复请求。
 */
const FETCH_LIMIT = 120;

const DEFAULT_MA: number[] = [5, 10, 20];

const fmt = (n: number, digits = 2) =>
  n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/**
 * 成交量格式化。
 *
 * ⚠️ 单位是**手**（1 手 = 100 股），不是股 —— 数据源（腾讯日 K / 快照）给的都是手。
 * 原实现把成交量和成交额共用一个 `fmtVolume`，且小数值走 `toFixed(0)`：
 * 45322 手被渲染成「5 万」，既没有单位、又因为四舍五入把 4.53 报成了 5。两处都不对。
 * 现在成交量固定带「手」字，且保留两位小数，读者不会把它当成股数。
 */
const fmtLots = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1e4 ? `${(n / 1e4).toFixed(2)} 万手` : `${Math.round(n)} 手`;
};

/** 成交额格式化，单位**元**（源值就是元），按量级切 亿 / 万 */
const fmtYuan = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
  return `${Math.round(n)} 元`;
};

const signed = (n: number, digits = 2) =>
  `${n > 0 ? '+' : ''}${fmt(n, digits)}`;

/**
 * 行情终端看板：数据源为 free-stockdb（本地量化数据引擎）。
 *
 * - 顶部跑马灯展示股票池全部标的的实时快照；
 * - 主图为蜡烛图，支持区间（30/60/120 日）与均线（5/10/20/60）切换、十字光标明细；
 * - 支持手动输入代码查询、可选每分钟自动刷新；
 * - 当 free-stockdb 服务未连通时，界面会明确标注「演示数据」，不伪装成真实行情。
 */
export function StockBoard() {
  const { settings } = useContent();
  const base = getSetting(settings, 'stock_api_base', DEFAULT_STOCK_BASE);
  const watchlist = useMemo(
    () => parseWatchlist(settings.stock_watchlist ?? ''),
    [settings.stock_watchlist]
  );

  const [code, setCode] = useState('');
  const [input, setInput] = useState('');
  const [range, setRange] = useState<RangeOption>(60);
  const [maWindows, setMaWindows] = useState<number[]>(DEFAULT_MA);
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // —— 搜索框状态 ——
  /** 联想候选（名称 / 拼音 / 代码三种输入都会走到这里） */
  const [suggest, setSuggest] = useState<SymbolHit[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState('');
  /** 键盘上下键选中的候选项下标，-1 表示未选中 */
  const [activeIdx, setActiveIdx] = useState(-1);
  /**
   * 用户从联想列表里选中的标的。
   *
   * 为什么要单独记：股票池（`watchlist`）里只有配置好的那几只，
   * 用户搜到的其它标的名称不在其中，不记住就只剩一个代码可显示。
   */
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  const searchBoxRef = useRef<HTMLDivElement>(null);
  /** 请求序号：丢弃「先发后到」的过期联想响应 */
  const searchSeq = useRef(0);

  // 股票池快照：用于顶部跑马灯与每只标的的迷你走势
  const { quotes } = useQuotes(base, watchlist, reloadToken);

  // 股票池就绪后默认选中第一只
  useEffect(() => {
    if (!code && watchlist.length) setCode(watchlist[0].code);
  }, [watchlist, code]);

  const load = useCallback(
    async (target: string) => {
      if (!target) return;
      setLoading(true);
      /**
       * 名称只作为「后端也没解析出来」时的退路，**绝不拿代码冒充名称**。
       * 早先这里写的是 `?? target`，于是搜索任意非股票池标的时，
       * 名称为空的后端结果会把代码当成公司名显示出来。
       */
      const name =
        (picked && picked.code === target ? picked.name : '') ||
        watchlist.find((w) => w.code === target)?.name ||
        '';
      const result = await fetchKlines(base, target, name, FETCH_LIMIT);
      setData(result);
      setLoading(false);
    },
    [base, watchlist, picked]
  );

  useEffect(() => {
    if (code) void load(code);
  }, [code, load, reloadToken]);

  // 自动刷新
  useEffect(() => {
    if (!auto || !code) return;
    const id = window.setInterval(() => void load(code), AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [auto, code, load]);

  /**
   * 关键词联想（去抖）。
   *
   * 两种输入都会被处理：
   * - 6 位纯数字 → 直接给候选（后端联想接口本身也支持按代码查）；
   * - 其它文本 → 当作名称或拼音简写。
   * 用递增序号丢弃过期响应，否则快速连打时先发的慢响应会覆盖后发的快响应，
   * 下拉列表里出现「上一次关键词」的结果。
   */
  useEffect(() => {
    const kw = input.trim();
    if (!kw) {
      setSuggest([]);
      setSearchMsg('');
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const seq = ++searchSeq.current;
      const res = await searchSymbols(kw);
      if (cancelled || seq !== searchSeq.current) return;
      setSuggest(res.items);
      setSearchMsg(res.message ?? '');
      setSearching(false);
      setActiveIdx(res.items.length ? 0 : -1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [input]);

  // 点击搜索框之外收起下拉
  useEffect(() => {
    if (!suggestOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!searchBoxRef.current?.contains(e.target as Node)) setSuggestOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [suggestOpen]);

  /** 选中一个标的：带上代码与名称，并清空输入 */
  const chooseSymbol = useCallback((hit: SymbolHit) => {
    setPicked(hit);
    setCode(hit.code);
    setInput('');
    setSuggest([]);
    setSearchMsg('');
    setSuggestOpen(false);
    setActiveIdx(-1);
  }, []);

  /** 提交：优先用高亮候选，其次用 6 位代码，最后取首个候选 */
  const submitSearch = () => {
    const kw = input.trim();
    if (activeIdx >= 0 && suggest[activeIdx]) {
      chooseSymbol(suggest[activeIdx]);
      return;
    }
    if (/^\d{6}$/.test(kw)) {
      chooseSymbol({
        code: kw,
        name: '',
        market: '',
        marketLabel: '',
        pinyin: '',
      });
      return;
    }
    if (suggest.length) chooseSymbol(suggest[0]);
  };

  /** 输入框内的键盘导航 */
  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!suggestOpen) setSuggestOpen(true);
      setActiveIdx((i) => (suggest.length ? (i + 1) % suggest.length : -1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (suggest.length ? (i - 1 + suggest.length) % suggest.length : -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSearch();
      return;
    }
    if (e.key === 'Escape') {
      setSuggestOpen(false);
      setActiveIdx(-1);
    }
  };

  const visible = useMemo(
    () => (data ? sliceRange(data.klines, range) : []),
    [data, range]
  );
  const metrics = useMemo(() => computeMetrics(visible), [visible]);
  const latest = visible[visible.length - 1];
  const prev = visible.length > 1 ? visible[visible.length - 2] : latest;

  const up = metrics ? metrics.change >= 0 : true;
  const isDemo = data?.source === 'demo';

  /**
   * 标题区显示的标的名字。
   *
   * 三级退路：后端解析出的名称 → 用户从联想列表选中的名称 → 代码本身。
   * 之前只有「后端名称」一级，且后端在主源（free-stockdb）下不返回名称，
   * 于是这里永远显示 `—`，用户以为「查到了数据但没有公司名称」。
   */
  const displayName = data?.name || picked?.name || data?.code || '—';

  // 清空缓存并递增令牌：主图与股票池快照的 effect 都会因此重新取数
  const refresh = useCallback(() => {
    resetStockCache();
    setReloadToken((v) => v + 1);
  }, []);

  const toggleMa = (w: number) => {
    setMaWindows((prevList) =>
      prevList.includes(w)
        ? prevList.filter((x) => x !== w)
        : [...prevList, w].sort((a, b) => a - b)
    );
  };

  return (
    <section className='card-soft relative overflow-hidden rounded-2xl'>
      <BorderBeam duration={5} />
      {/* 顶部氛围晕圈 */}
      <div
        aria-hidden
        className='pointer-events-none absolute -top-24 left-1/4 h-56 w-2/3 bg-flare-200/40 blur-[90px]'
      />

      {/* 标题栏 */}
      <header className='relative flex flex-wrap items-center justify-between gap-3 border-b border-ink-900/[0.07] bg-white/70 px-4 py-3 sm:px-5'>
        <div className='flex flex-wrap items-center gap-2.5'>
          <span className='relative flex h-2 w-2'>
            <span
              className={cn(
                'absolute inline-flex h-full w-full rounded-full opacity-70',
                isDemo ? 'bg-amber-400' : 'animate-ping bg-bear'
              )}
            />
            <span
              className={cn(
                'relative inline-flex h-2 w-2 rounded-full',
                isDemo ? 'bg-amber-400' : 'bg-bear'
              )}
            />
          </span>
          <Activity className='h-4 w-4 text-flare-500' />
          <h3 className='text-sm font-semibold tracking-wide text-ink-900'>
            行情终端
          </h3>
          <span className='num hidden text-[10px] uppercase tracking-[0.18em] text-ink-300 sm:inline'>
            market terminal
          </span>
          {data ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                isDemo
                  ? 'border-amber-300 bg-amber-50 text-amber-700'
                  : 'border-bear/25 bg-bear/10 text-bear-dark'
              )}
            >
              {isDemo ? (
                <TriangleAlert className='h-3 w-3' />
              ) : (
                <SignalHigh className='h-3 w-3' />
              )}
              {isDemo ? '演示数据' : '实时数据'}
            </span>
          ) : null}
        </div>

        <div className='flex items-center gap-2'>
          <label className='flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-ink-900/10 bg-white px-2.5 py-1.5 text-[11px] text-ink-500 transition-colors hover:text-ink-800'>
            <input
              type='checkbox'
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className='h-3.5 w-3.5 accent-[#f8574a]'
            />
            每分钟自动刷新
          </label>
          <button
            type='button'
            onClick={refresh}
            disabled={loading}
            className='inline-flex items-center gap-1.5 rounded-md border border-flare-200 bg-flare-50 px-2.5 py-1.5 text-[11px] font-medium text-flare-700 transition-colors hover:border-flare-300 hover:bg-flare-100 disabled:opacity-50'
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            更新看板
          </button>
        </div>
      </header>

      {/* 跑马灯行情条 */}
      {quotes.length ? (
        <div className='relative border-b border-ink-900/[0.07] bg-flare-50/50'>
          <Marquee duration={Math.max(28, quotes.length * 6)}>
            {quotes.map((q) => (
              <button
                key={`tick-${q.code}`}
                type='button'
                onClick={() => setCode(q.code)}
                className='flex shrink-0 items-center gap-2 px-1 text-[11px] transition-opacity hover:opacity-75'
              >
                <span className='font-medium text-ink-700'>{q.name}</span>
                <span className='num text-ink-400'>{q.code}</span>
                <span className='num font-semibold text-ink-900'>
                  {fmt(q.price)}
                </span>
                <span
                  className={cn(
                    'num font-semibold',
                    q.changePct >= 0 ? 'text-bull' : 'text-bear'
                  )}
                >
                  {q.changePct >= 0 ? '▲' : '▼'}{' '}
                  {Math.abs(q.changePct).toFixed(2)}%
                </span>
              </button>
            ))}
          </Marquee>
        </div>
      ) : null}

      {/* 股票池选择 */}
      <div className='flex flex-wrap items-center gap-2 border-b border-ink-900/[0.07] px-4 py-3 sm:px-5'>
        {watchlist.map((item) => {
          const q = quotes.find((x) => x.code === item.code);
          const itemUp = q ? q.changePct >= 0 : true;
          const active = code === item.code;
          return (
            <button
              key={item.code}
              type='button'
              onClick={() => setCode(item.code)}
              className={cn(
                'group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-all duration-300',
                active
                  ? 'border-flare-200 bg-flare-50 shadow-glow-flare'
                  : 'border-ink-900/[0.08] bg-white hover:border-flare-200 hover:bg-flare-50/50'
              )}
            >
              <span className='min-w-0'>
                <span
                  className={cn(
                    'block text-xs font-medium',
                    active ? 'text-flare-700' : 'text-ink-700'
                  )}
                >
                  {item.name}
                </span>
                <span className='num block text-[10px] text-ink-400'>
                  {item.code}
                </span>
              </span>
              {q ? (
                <>
                  <Sparkline
                    values={q.spark}
                    up={itemUp}
                    width={54}
                    height={20}
                  />
                  <span
                    className={cn(
                      'num text-[10px] font-semibold',
                      itemUp ? 'text-bull' : 'text-bear'
                    )}
                  >
                    {itemUp ? '+' : ''}
                    {q.changePct.toFixed(2)}%
                  </span>
                </>
              ) : null}
            </button>
          );
        })}

        {/* 搜索到的标的不在股票池里时，补一个选中态卡片，让「当前看的是谁」一目了然 */}
        {code && !watchlist.some((w) => w.code === code) ? (
          <span className='flex items-center gap-2 rounded-lg border border-flare-200 bg-flare-50 px-3 py-1.5 text-left shadow-glow-flare'>
            <span className='min-w-0'>
              <span className='block max-w-[9rem] truncate text-xs font-medium text-flare-700'>
                {data?.name || picked?.name || '查询结果'}
              </span>
              <span className='num block text-[10px] text-ink-400'>{code}</span>
            </span>
          </span>
        ) : null}

        {/* 搜索：支持股票名称 / 拼音简写 / 6 位代码，带联想下拉 */}
        <div ref={searchBoxRef} className='relative ml-auto'>
          <div className='flex items-center gap-1.5'>
            <div className='relative'>
              {searching ? (
                <Loader2 className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-flare-500' />
              ) : (
                <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400' />
              )}
              <input
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => setSuggestOpen(true)}
                onKeyDown={onSearchKeyDown}
                placeholder='股票名称 / 代码 / 拼音'
                aria-label='按股票名称、拼音或代码搜索'
                autoComplete='off'
                className='field-dark h-8 w-44 pl-8 pr-7 text-xs'
              />
              {input ? (
                <button
                  type='button'
                  onClick={() => {
                    setInput('');
                    setSuggest([]);
                    setSuggestOpen(false);
                  }}
                  title='清空'
                  className='absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 transition-colors hover:text-ink-700'
                >
                  <X className='h-3 w-3' />
                </button>
              ) : null}
            </div>
            <button
              type='button'
              onClick={submitSearch}
              className='h-8 rounded-md border border-flare-200 bg-flare-50 px-3 text-xs font-medium text-flare-700 transition-colors hover:bg-flare-100'
            >
              查询
            </button>
          </div>

          {/* 联想下拉 */}
          {suggestOpen && (input.trim() || suggest.length) ? (
            <div className='absolute right-0 top-9 z-30 w-80 overflow-hidden rounded-xl border border-ink-900/10 bg-white shadow-card-hover'>
              {suggest.length ? (
                <ul className='max-h-72 overflow-auto py-1'>
                  {suggest.map((hit, i) => (
                    <li key={`${hit.code}-${hit.name}`}>
                      <button
                        type='button'
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => chooseSymbol(hit)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                          i === activeIdx ? 'bg-flare-50' : 'hover:bg-ink-50'
                        )}
                      >
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-xs font-medium text-ink-900'>
                            {hit.name}
                          </span>
                          <span className='num block text-[10px] text-ink-400'>
                            {hit.marketLabel} · {hit.code}
                          </span>
                        </span>
                        {hit.pinyin ? (
                          <span className='num shrink-0 rounded border border-ink-900/[0.07] bg-ink-50 px-1.5 py-0.5 text-[10px] uppercase text-ink-400'>
                            {hit.pinyin}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='px-3 py-3 text-[11px] text-ink-400'>
                  {searching
                    ? '正在搜索…'
                    : searchMsg || (input.trim() ? '没有匹配的 A 股标的' : '输入名称、拼音或代码开始搜索')}
                </p>
              )}

              {suggest.length && searchMsg ? (
                <p className='border-t border-ink-900/[0.07] px-3 py-1.5 text-[10px] text-amber-700'>
                  {searchMsg}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* 主区：报价摘要 + 图表 */}
      <div className='grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-[270px_1fr] lg:gap-6'>
        {/* 报价摘要 */}
        <div className='flex flex-col gap-4'>
          <div>
            <p className='text-xs text-ink-500'>
              {displayName}
              {data?.code && displayName !== data.code ? (
                <span className='num ml-2 text-ink-400'>{data.code}</span>
              ) : null}
            </p>
            <p
              className={cn(
                'num mt-1.5 text-4xl font-semibold tracking-tight transition-colors duration-500',
                metrics
                  ? up
                    ? 'glow-text-bull text-bull'
                    : 'glow-text-bear text-bear'
                  : 'text-ink-300'
              )}
            >
              {metrics ? fmt(metrics.latest) : '--.--'}
            </p>
            {metrics ? (
              <p
                className={cn(
                  'num mt-1 text-sm font-medium',
                  up ? 'text-bull' : 'text-bear'
                )}
              >
                {signed(metrics.change)} ({signed(metrics.changePct)}%)
                <span className='ml-2 text-[11px] text-ink-400'>较昨收</span>
              </p>
            ) : null}
          </div>

          {/* 关键指标 */}
          <dl className='grid grid-cols-2 gap-x-4 gap-y-2 border-t border-ink-900/[0.07] pt-4 text-xs lg:grid-cols-1'>
            <Stat label='今开' value={latest ? fmt(latest.open) : '—'} />
            <Stat
              label='最高'
              value={latest ? fmt(latest.high) : '—'}
              tone='up'
            />
            <Stat
              label='最低'
              value={latest ? fmt(latest.low) : '—'}
              tone='down'
            />
            <Stat label='昨收' value={prev ? fmt(prev.close) : '—'} />
            <Stat
              label='成交量'
              value={latest ? fmtLots(latest.volume) : '—'}
            />
            <Stat
              label='成交额'
              value={latest ? fmtYuan(latest.amount) : '—'}
            />
            <Stat
              label='区间振幅'
              value={metrics ? `${fmt(metrics.amplitude)}%` : '—'}
            />
            <Stat
              label={`${range} 日涨跌`}
              value={metrics ? `${signed(metrics.rangeChangePct)}%` : '—'}
              tone={
                metrics
                  ? metrics.rangeChangePct >= 0
                    ? 'up'
                    : 'down'
                  : undefined
              }
            />
          </dl>

          {/* 均线数值 */}
          <div className='hidden border-t border-ink-900/[0.07] pt-3 lg:block'>
            <p className='text-[10px] uppercase tracking-[0.16em] text-ink-400'>
              均线
            </p>
            <div className='mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs'>
              {MA_WINDOWS.map((w) => {
                const value = maValue(metrics, w);
                const on = maWindows.includes(w);
                return (
                  <span key={w} className='flex items-center justify-between'>
                    <span className='flex items-center gap-1.5'>
                      <span
                        className='inline-block h-0.5 w-3 rounded-full'
                        style={{
                          background: MA_COLORS[w],
                          opacity: on ? 1 : 0.3,
                        }}
                      />
                      <span className={on ? 'text-ink-500' : 'text-ink-300'}>
                        MA{w}
                      </span>
                    </span>
                    <span
                      className={cn('num', on ? 'text-ink-800' : 'text-ink-300')}
                    >
                      {value == null ? '—' : fmt(value)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        {/* 图表区 */}
        <div className='min-w-0'>
          <div className='mb-3 flex flex-wrap items-center gap-2'>
            {/* 区间切换 */}
            <div className='inline-flex rounded-lg border border-ink-900/10 bg-ink-50 p-0.5'>
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type='button'
                  onClick={() => setRange(opt)}
                  className={cn(
                    'num rounded-md px-2.5 py-1 text-[11px] transition-colors',
                    range === opt
                      ? 'bg-white text-flare-700 shadow-card'
                      : 'text-ink-500 hover:text-ink-800'
                  )}
                >
                  {opt} 日
                </button>
              ))}
            </div>

            {/* 均线切换 */}
            <div className='inline-flex gap-1'>
              {MA_WINDOWS.map((w) => {
                const on = maWindows.includes(w);
                return (
                  <button
                    key={`ma-toggle-${w}`}
                    type='button'
                    onClick={() => toggleMa(w)}
                    aria-pressed={on}
                    className={cn(
                      'num rounded-md border px-2 py-1 text-[11px] transition-all',
                      on
                        ? 'border-ink-900/15 bg-white text-ink-800'
                        : 'border-ink-900/[0.07] text-ink-300 hover:text-ink-600'
                    )}
                    style={
                      on
                        ? { boxShadow: `inset 0 -2px 0 0 ${MA_COLORS[w]}` }
                        : undefined
                    }
                  >
                    MA{w}
                  </button>
                );
              })}
            </div>

            <span className='ml-auto hidden text-[10px] text-ink-400 sm:inline'>
              移动光标查看单日明细 · 红涨绿跌
            </span>
          </div>

          <Reveal from='none'>
            {data && visible.length ? (
              <div
                className={cn(
                  'transition-opacity duration-300',
                  loading && 'opacity-50'
                )}
              >
                <CandleChart
                  klines={visible}
                  maWindows={maWindows}
                  height={380}
                />
              </div>
            ) : (
              <div className='flex h-[380px] items-center justify-center text-sm text-ink-400'>
                {loading ? '正在加载行情数据…' : '请选择一只股票'}
              </div>
            )}
          </Reveal>
        </div>
      </div>

      {/* 底部说明 */}
      <div className='flex items-start gap-2 border-t border-ink-900/[0.07] bg-ink-50/70 px-4 py-3 text-[11px] text-ink-500 sm:px-5'>
        <Info className='mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400' />
        <div className='space-y-1'>
          <p>
            数据源：
            <a
              href='https://github.com/hello245m/free-stockdb'
              target='_blank'
              rel='noreferrer'
              className='text-flare-600 underline-offset-2 hover:underline'
            >
              free-stockdb
            </a>
            （本地量化数据引擎，服务地址{' '}
            <span className='code-chip'>{base || DEFAULT_STOCK_BASE}</span>
            ，可在内容管理中配置）。
          </p>
          {data?.message ? (
            <p className='text-amber-700'>{data.message}</p>
          ) : null}
          <p>
            标的检索支持<b>股票名称 / 拼音简写 / 6 位代码</b>
            （由腾讯联想接口提供，仅返回沪深北 A 股个股）。
          </p>
          <p>本看板仅用于社团内部学习与研究，不构成任何投资建议。</p>
        </div>
      </div>
    </section>
  );
}

/** 从指标对象里按窗口取均线值（避免用字符串下标访问） */
function maValue(
  metrics: ReturnType<typeof computeMetrics>,
  window: number
): number | null {
  if (!metrics) return null;
  switch (window) {
    case 5:
      return metrics.ma5;
    case 10:
      return metrics.ma10;
    case 20:
      return metrics.ma20;
    case 60:
      return metrics.ma60;
    default:
      return null;
  }
}

interface StatProps {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}

function Stat({ label, value, tone }: StatProps) {
  return (
    <div className='flex items-baseline justify-between gap-2'>
      <dt className='text-ink-500'>{label}</dt>
      <dd
        className={cn(
          'num font-medium',
          tone === 'up' && 'text-bull',
          tone === 'down' && 'text-bear',
          !tone && 'text-ink-800'
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export default StockBoard;
