/**
 * 行情数据接入层 —— 对接 free-stockdb（本地量化数据引擎）。
 *
 * 数据源：https://github.com/hello245m/free-stockdb
 * 该引擎以**本地 HTTP 服务**方式提供数据，默认监听 `http://127.0.0.1:7899`，
 * 调用协议形如：`GET {base}/?cmd=get&t=日k:600702*`
 * （`t` 的格式是 `表名:主键`，`*` 表示通配/全量，与 free-stockdb 的 `rd.get()` 一致）。
 *
 * 由于服务部署在社团自己的机器上，浏览器直连时需注意两点：
 * 1. 前端所在页面必须能访问该地址（同机部署或已配置 CORS）；
 * 2. 若服务未启动，本模块会回退到**演示数据**并在看板上明确标注，不会假装成真实行情。
 *
 * 服务地址与股票池均由站点配置（`stock_api_base` / `stock_watchlist`）控制，可在内容管理页修改。
 */

/** 单根 K 线 / 快照 */
export interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** 看板数据结果 */
export interface BoardData {
  code: string;
  name: string;
  klines: Kline[];
  /**
   * 数据来源：
   * - `free-stockdb`：主源（经自建后端代理，或本地直连）
   * - `tencent`：回退源（后端在主源不可达时自动切换）
   * - `demo`：演示数据 —— **仅在前两者都不可用时出现，且界面会显式标注**
   */
  source: 'free-stockdb' | 'tencent' | 'demo';
  /** 失败原因（回退到演示数据时给出） */
  message?: string;
}

/** 搜索结果中的一条标的（来自后端 /api/stock/search） */
export interface SymbolHit {
  code: string;
  name: string;
  market: string;
  /** 交易所中文名，如「上交所」 */
  marketLabel: string;
  /** 拼音简写，如 «gzmt» */
  pinyin: string;
}

/** 默认服务地址 */
export const DEFAULT_STOCK_BASE = 'http://127.0.0.1:7899';

/** 看板默认展示的交易日数量 */
export const KLINE_LIMIT = 60;

/** 可选的区间档位（交易日数量） */
export const RANGE_OPTIONS = [30, 60, 120] as const;
export type RangeOption = (typeof RANGE_OPTIONS)[number];

/** 支持的均线窗口（看板与图表共用同一份定义） */
export const MA_WINDOWS = [5, 10, 20, 60] as const;

/**
 * 均线配色。
 * 白底上需要与红涨绿跌的蜡烛明确区分，因此避开纯红与纯绿：
 * 金 / 蓝 / 紫 / 中性灰。
 */
export const MA_COLORS: Record<number, string> = {
  5: '#c9961a',
  10: '#2f6fed',
  20: '#8b5cf6',
  60: '#6f6f6f',
};

/** 成功结果缓存时长 */
const CACHE_TTL_MS = 30_000;
/** 连续失败后进入「冷却」的时长，期间直接判定不可达，避免每只股票都等满超时 */
const COOLDOWN_MS = 60_000;
/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 6000;

interface CacheEntry {
  at: number;
  data: BoardData;
}

const cache = new Map<string, CacheEntry>();

/** 服务不可达的冷却截止时间戳（0 表示未进入冷却） */
let unreachableUntil = 0;
/** 最近一次失败原因，供界面展示 */
let lastError = '';

const cacheKey = (base: string, code: string, limit: number) =>
  `${base || DEFAULT_STOCK_BASE}|${code}|${limit}`;

/** 当前是否处于「已判定服务不可达」的冷却期 */
export function isServiceCoolingDown(): boolean {
  return Date.now() < unreachableUntil;
}

/** 手动清除缓存与冷却状态（用户点击「更新看板」时调用，强制走真实请求） */
export function resetStockCache(): void {
  cache.clear();
  unreachableUntil = 0;
}

/**
 * 按区间截取 K 线尾部。
 * 区间数大于实际长度时返回全部，保证小样本股票也能正常渲染。
 */
export function sliceRange(klines: Kline[], days: number): Kline[] {
  return days >= klines.length ? klines : klines.slice(-days);
}

/**
 * 迷你走势：给股票池的每个标的一条仅含收盘价的小序列。
 * 无数据时返回空数组，由组件决定是否展示占位。
 */
export function sparkOf(klines: Kline[], points = 24): number[] {
  if (klines.length <= points) return klines.map((k) => k.close);
  const step = klines.length / points;
  const out: number[] = [];
  for (let i = 0; i < points; i += 1) {
    out.push(klines[Math.min(klines.length - 1, Math.floor(i * step))].close);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 生成最近 n 个交易日（跳过周末）的日期列表，按时间升序 */
function recentTradingDays(n: number): string[] {
  const days: string[] = [];
  const cursor = new Date();
  while (days.length < n) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days.push(toDateStr(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return days.reverse();
}

/** 由股票代码派生的稳定整数种子 */
function seedOf(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i += 1) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 线性同余伪随机数生成器（保证同一代码每次渲染得到同一条曲线） */
function createRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * 构造演示行情序列。
 * ⚠️ 仅用于数据服务未接入时的界面演示，**不是真实行情**，界面会显式标注。
 */
export function buildDemoKlines(
  code: string,
  limit = KLINE_LIMIT
): Kline[] {
  const rand = createRandom(seedOf(code));
  let price = 8 + rand() * 90;
  return recentTradingDays(limit).map((date) => {
    const drift = (rand() - 0.48) * price * 0.03;
    const open = price;
    const close = Math.max(0.5, open + drift);
    const high = Math.max(open, close) * (1 + rand() * 0.012);
    const low = Math.min(open, close) * (1 - rand() * 0.012);
    const volume = Math.round(2_000_000 + rand() * 20_000_000);
    price = close;
    return {
      date,
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
      amount: Math.round(volume * close),
    };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 构造 free-stockdb 的请求地址 */
export function buildStockUrl(base: string, code: string): string {
  const root = (base || DEFAULT_STOCK_BASE).replace(/\/+$/, '');
  const query = `cmd=get&t=${encodeURIComponent(`日k:${code}*`)}`;
  return `${root}/?${query}`;
}

/** 从任意嵌套结构中找出「行数组」 */
function pickRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    // 形如 [[...],[...]] 的行数组，或形如 [ {..}, {..} ]
    if (payload.length === 0) return [];
    const first = payload[0];
    if (Array.isArray(first) || (first && typeof first === 'object')) {
      return payload;
    }
    return [];
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'result', 'list', 'rows', 'values', 'kline']) {
      if (key in obj) {
        const rows = pickRows(obj[key]);
        if (rows.length) return rows;
      }
    }
    // 形如 { "600702": [...] }
    for (const value of Object.values(obj)) {
      const rows = pickRows(value);
      if (rows.length) return rows;
    }
  }
  return [];
}

const toNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 日期归一化：支持 20260623 / 2026-06-23 / 时间戳 */
function normalizeDate(v: unknown, fallback: string): string {
  const s = String(v ?? '');
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return fallback;
}

/**
 * 把 free-stockdb 的返回解析为 K 线序列。
 * 兼容两种行格式：
 *  - 数组行：`[日期, 开, 高, 低, 收, 量, 额]`
 *  - 对象行：`{ date|日期, open|开盘, high|最高, low|最低, close|收盘, volume|成交量, amount|成交额 }`
 */
export function parseKlines(payload: unknown, limit = KLINE_LIMIT): Kline[] {
  const rows = pickRows(payload);
  const dates = recentTradingDays(Math.max(rows.length, limit));
  const out: Kline[] = [];

  rows.forEach((row, index) => {
    const fallbackDate = dates[Math.min(index, dates.length - 1)] ?? '';
    if (Array.isArray(row)) {
      if (row.length < 5) return;
      out.push({
        date: normalizeDate(row[0], fallbackDate),
        open: toNumber(row[1]),
        high: toNumber(row[2]),
        low: toNumber(row[3]),
        close: toNumber(row[4]),
        volume: toNumber(row[5]),
        amount: toNumber(row[6]),
      });
      return;
    }
    if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          if (o[k] !== undefined && o[k] !== null) return o[k];
        }
        return undefined;
      };
      const close = toNumber(pick('close', '收盘', 'c'));
      out.push({
        date: normalizeDate(pick('date', '日期', 'time', 'trade_date'), fallbackDate),
        open: toNumber(pick('open', '开盘', 'o')) || close,
        high: toNumber(pick('high', '最高', 'h')) || close,
        low: toNumber(pick('low', '最低', 'l')) || close,
        close,
        volume: toNumber(pick('volume', '成交量', 'vol', 'v')),
        amount: toNumber(pick('amount', '成交额', 'turnover')),
      });
    }
  });

  return out.filter((k) => k.close > 0).slice(-limit);
}

/** 构造回退到演示数据的结果 */
function demoResult(
  base: string,
  code: string,
  name: string,
  limit: number,
  reason: string
): BoardData {
  return {
    code,
    name,
    klines: buildDemoKlines(code, limit),
    source: 'demo',
    message: `${reason}（未连接到 free-stockdb ${base || DEFAULT_STOCK_BASE}，当前展示演示数据）`,
  };
}

/**
 * 通过自建后端拉取 K 线。
 *
 * 为什么优先走后端而不是浏览器直连 free-stockdb：
 * 1. free-stockdb 是 `http://127.0.0.1:7899`，而线上站点是 `https`。
 *    浏览器会以**混合内容（Mixed Content）**为由直接拦截该请求，
 *    表现为「本地开发能出图、上线后一片空白」——这类问题定位成本很高。
 *    后端代理后，浏览器只与同源通信，不存在该限制。
 * 2. free-stockdb 需要常驻运行，浏览器直连等于要求每个访问者的机器上都装它。
 *    走后端则只需服务器部署一份。
 * 3. 后端已实现「free-stockdb 主源 + 腾讯回退源」的多源适配，
 *    比前端的单源直连更健壮。
 *
 * @returns 成功返回 BoardData；接口不可用时返回 null，由调用方决定是否降级
 */
async function fetchKlinesViaBackend(
  code: string,
  name: string,
  limit: number
): Promise<BoardData | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(
      `/api/stock/kline?code=${encodeURIComponent(code)}&limit=${limit}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const body = (await res.json()) as {
      ok?: boolean;
      data?: { klines?: unknown[]; source?: string; name?: string };
    };
    if (!body?.ok || !Array.isArray(body.data?.klines) || body.data.klines.length === 0) {
      return null;
    }

    // 后端已把结构规整为 { date, open, close, high, low, volume }，
    // 这里只做数值兜底，不再重新解析原始行格式。
    const klines: Kline[] = body.data.klines
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          date: String(r.date ?? ''),
          open: toNumber(r.open),
          close: toNumber(r.close),
          high: toNumber(r.high),
          low: toNumber(r.low),
          volume: toNumber(r.volume),
          amount: toNumber(r.amount),
        };
      })
      .filter((k) => k.close > 0);

    if (!klines.length) return null;

    const src = body.data.source ?? 'backend';
    /**
     * 名称的取值优先级：**后端解析出的名称 > 调用方传入的名称**。
     *
     * 这里曾写反过：只用调用方传入的 `name`。调用方对「股票池里的标的」能给出真名，
     * 但对「用户手动输入代码查询」只能把代码本身当名字传进来，
     * 于是界面上永远显示 `600702` 而不是「舍得酒业」——表现为「查到了数据却没有公司名称」。
     * 后端现在会兜底解析名称（free-stockdb 主源没有名称字段，见 server/lib/stock.js），
     * 因此以它为准，传参仅作后端也没拿到时的退路。
     */
    const backendName =
      typeof body.data?.name === 'string' ? body.data.name.trim() : '';
    return {
      code,
      name: backendName || name,
      klines,
      source: src === 'tencent' ? 'tencent' : 'free-stockdb',
      message: src === 'tencent' ? '数据经后端代理取自回退源（腾讯行情）' : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 拉取某只股票的日 K 数据。
 *
 * 四级策略，保证「服务没开」时界面依然秒开：
 * 1. 命中 30s 内的成功缓存 → 直接返回；
 * 2. 优先经**自建后端**取真实数据（后端自己处理主源/回退源）；
 * 3. 后端不可用时，尝试浏览器直连 free-stockdb（仅本地开发场景有效）；
 * 4. 都失败则回退演示数据，并在结果里说明原因，绝不伪装成真实行情。
 */
export async function fetchKlines(
  base: string,
  code: string,
  name: string,
  limit = KLINE_LIMIT,
  force = false
): Promise<BoardData> {
  const key = cacheKey(base, code, limit);
  const hit = cache.get(key);

  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // 缓存里可能已经带着后端解析出的真实名称，此时不要用调用方传入的占位值（往往是代码）盖掉它
    return { ...hit.data, name: hit.data.name || name };
  }

  // —— 第 2 级：自建后端（线上与本地开发都走这条）——
  const viaBackend = await fetchKlinesViaBackend(code, name, limit);
  if (viaBackend) {
    unreachableUntil = 0;
    lastError = '';
    cache.set(key, { at: Date.now(), data: viaBackend });
    return viaBackend;
  }

  // —— 第 3 级：浏览器直连 free-stockdb（仅本地可用）——
  if (!force && isServiceCoolingDown()) {
    return demoResult(base, code, name, limit, lastError || '服务暂时不可用');
  }

  const url = buildStockUrl(base, code);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as unknown;
    const klines = parseKlines(payload, limit);
    if (!klines.length) {
      throw new Error('返回数据为空或字段未识别');
    }

    unreachableUntil = 0;
    lastError = '';
    const data: BoardData = { code, name, klines, source: 'free-stockdb' };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    lastError = reason;
    unreachableUntil = Date.now() + COOLDOWN_MS;
    // 冷却期内所有股票共用演示数据，无需为每只都等一次超时
    return demoResult(base, code, name, limit, reason);
  }
}

/** 联想请求去抖时长 */
export const SEARCH_DEBOUNCE_MS = 250;

/** 搜索结果的短缓存：边打边搜会重复命中同一前缀 */
const SEARCH_CACHE_TTL_MS = 60_000;
const searchCache = new Map<string, { at: number; items: SymbolHit[] }>();

/** 搜索结果类型（用于界面区分「正在搜」「搜不到」「接口不可用」） */
export interface SymbolSearchResult {
  items: SymbolHit[];
  /** 接口级说明（如联想源不可用） */
  message?: string;
}

/**
 * 按关键词搜索 A 股标的。
 *
 * 支持三种输入，用户不必记住代码：
 * - 股票名称：「宁德时代」「舍得」
 * - 拼音简写：「gzmt」「ndsd」
 * - 6 位代码：「600702」
 *
 * 走后端 `/api/stock/search`（后端再代理腾讯联想接口）而不是前端直连：
 * 与 K 线取数同理 —— 线上站点是 HTTPS，直连第三方接口会踩跨域与混合内容限制。
 *
 * 失败时**不抛错**，返回空列表并带 `message`：搜索框是个辅助控件，
 * 不应该因为它连不上就把整个行情终端变成错误页。
 *
 * @param keyword 关键词
 */
export async function searchSymbols(keyword: string): Promise<SymbolSearchResult> {
  const kw = keyword.trim();
  if (!kw) return { items: [] };

  const cached = searchCache.get(kw);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return { items: cached.items };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(`/api/stock/search?kw=${encodeURIComponent(kw)}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { items: [], message: `搜索接口返回 HTTP ${res.status}` };
    }

    const body = (await res.json()) as {
      ok?: boolean;
      data?: { items?: unknown[]; message?: string | null };
      error?: { message?: string };
    };
    if (!body?.ok) {
      return { items: [], message: body?.error?.message ?? '搜索接口不可用' };
    }

    const items: SymbolHit[] = (body.data?.items ?? [])
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          code: String(r.code ?? ''),
          name: String(r.name ?? ''),
          market: String(r.market ?? ''),
          marketLabel: String(r.marketLabel ?? ''),
          pinyin: String(r.pinyin ?? ''),
        };
      })
      .filter((it) => /^\d{6}$/.test(it.code) && it.name);

    searchCache.set(kw, { at: Date.now(), items });
    return { items, message: body.data?.message ?? undefined };
  } catch (err) {
    return {
      items: [],
      message: err instanceof Error && err.name === 'AbortError'
        ? '搜索请求超时'
        : '搜索服务暂不可用（请确认后端已启动）',
    };
  }
}

/** 均线计算 */
export function movingAverage(values: number[], window: number): (number | null)[] {  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(i >= window - 1 ? round2(sum / window) : null);
  }
  return out;
}

/** 区间统计（用于看板右侧指标卡） */
export interface BoardMetrics {
  latest: number;
  prevClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  /** 区间振幅（%）：`(区间最高 − 区间最低) ÷ 区间首日收盘价 × 100` */
  amplitude: number;
  /** 区间累计涨跌幅（%） */
  rangeChangePct: number;
}

export function computeMetrics(klines: Kline[]): BoardMetrics | null {
  if (!klines.length) return null;
  const closes = klines.map((k) => k.close);
  const latest = closes[closes.length - 1];
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : latest;
  const ma = (w: number) => movingAverage(closes, w)[closes.length - 1] ?? null;
  const last = klines[klines.length - 1];
  const high = Math.max(...klines.map((k) => k.high));
  const low = Math.min(...klines.map((k) => k.low));
  const base = closes[0];

  return {
    latest,
    prevClose,
    change: round2(latest - prevClose),
    changePct: prevClose ? round2(((latest - prevClose) / prevClose) * 100) : 0,
    high,
    low,
    volume: last.volume,
    amount: last.amount,
    ma5: ma(5),
    ma10: ma(10),
    ma20: ma(20),
    ma60: ma(60),
    /**
     * 区间振幅。
     *
     * 定义：`(区间最高 − 区间最低) ÷ 区间首日收盘价 × 100%`。
     *
     * 这里改过一次，原因值得留档：原实现是「区间内**单日**振幅的最大值」，
     * 且分母写成了**当日收盘**。两个问题叠在一起 ——
     * ① 振幅的行业口径分母是**昨收**，用今收算会差零点几个百分点；
     * ② 标签写着「区间振幅」，读者看到的却是一根 K 线的振幅，名实不符。
     * 现在改成用区间自身的高低点，基准取**区间首日收盘价**，
     * 与同一张卡上的「N 日涨跌」同基准，两个数字可以直接对照着读。
     *
     * 单日振幅不做在这里：它属于「当日」指标，源头的快照里直接带（`amplitude` 字段）。
     */
    amplitude: base ? round2(((high - low) / base) * 100) : 0,
    rangeChangePct: base ? round2(((latest - base) / base) * 100) : 0,
  };
}
