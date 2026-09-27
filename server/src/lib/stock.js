/**
 * 行情代理：把浏览器对行情源的请求收口到后端，解决混合内容问题。
 *
 * ## 为什么需要它
 * 站点若部署在 HTTPS 下，浏览器会直接拦截页面发出的 `http://127.0.0.1:7899`
 * 请求（Mixed Content）。由后端（Node，不受同源策略约束）去取数并同源回吐，
 * 前端就只需要访问 `/api/stock/*`。
 *
 * ## 双源适配 + 优雅回退
 * - **首选** free-stockdb（本地量化数据引擎，`GET {base}/?cmd=get&t=日k:<code>:<date>`）
 * - **回退** 腾讯行情：
 *   - 实时快照 `https://qt.gtimg.cn/q=sh600702`（**GBK 编码，必须转 UTF-8**）
 *   - 日 K `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600702,day,,,120,qfq`
 *
 * 每次响应都会带 `source` 字段（`free-stockdb` / `tencent` / `demo`）说明本次用的是哪个源，
 * 前端可据此如实展示，不把回退数据伪装成主源数据。
 */
import {
  detectMarket,
  toTencentSymbol,
  parseTencentSnapshot,
  parseSmartboxHints,
  pickTencentAmount,
  isAShareQuotable,
} from './symbols.js';

/** free-stockdb 默认地址（与其 rd.get() 协议一致） */
export const DEFAULT_FREE_STOCKDB_BASE = 'http://127.0.0.1:7899';

/** 适配器探测与取数的超时 */
const PROBE_TIMEOUT_MS = 1200;
const FETCH_TIMEOUT_MS = 6000;

/** 可用性探测结果的缓存时长：避免每个请求都去试探不可达的本地服务 */
const PROBE_CACHE_MS = 60_000;

/** 腾讯实时快照端点 */
const TENCENT_SNAPSHOT_URL = 'https://qt.gtimg.cn/q=';
/** 腾讯日 K（前复权）端点 */
const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
/**
 * 腾讯「搜索联想」端点。
 *
 * 它同时承担两件事：给用户做**按名称搜索**，以及给后端做**代码 → 名称**的反查。
 * 后者很关键 —— free-stockdb 的日 K 表里只有数字，没有股票名称，
 * 于是走主源时名称一直是空字符串，界面上只剩代码（这正是「搜到数据但不显示公司名」的根因之一）。
 */
const TENCENT_SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/';

/** 联想与名称反查的超时（比日 K 短：它只是锦上添花，不能拖慢主链路） */
const SMARTBOX_TIMEOUT_MS = 2500;
/** 名称反查的超时（同上，且失败即放弃，绝不阻断行情返回） */
const NAME_LOOKUP_TIMEOUT_MS = 1500;

/** 名称缓存时长：股票名称极少变动，可以缓存很久 */
const NAME_CACHE_MS = 12 * 60 * 60 * 1000;
/** 联想结果缓存时长：同一关键词短时间内会被反复输入 */
const SMARTBOX_CACHE_MS = 5 * 60 * 1000;
/** 单次联想最多返回的候选数 */
const SMARTBOX_MAX_ITEMS = 12;

/**
 * 解码 GBK 字节流。
 *
 * 腾讯 `qt.gtimg.cn` 返回 GBK（而非 UTF-8）。Node 内置 `TextDecoder` 在
 * 完整 ICU 构建下支持 `gbk`（Node 22 官方发行版均为 full-icu）。
 * 若运行环境的 ICU 不含 GBK，则退回 latin1 解码并给出提示 —— 行情数字与
 * 代码仍然可用，只有中文名可能乱码，不会整体失败。
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ text: string, encoding: 'gbk' | 'latin1' }}
 */
export function decodeGbk(buffer) {
  try {
    return {
      text: new TextDecoder('gbk', { fatal: false }).decode(buffer),
      encoding: 'gbk',
    };
  } catch {
    return {
      text: new TextDecoder('latin1').decode(buffer),
      encoding: 'latin1',
    };
  }
}

/** 带超时的 fetch */
async function get(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * 请求腾讯联想接口，返回**未过滤**的候选条目。
 *
 * 编码说明：响应是 GBK 传输，但中文以 ASCII 的 `\uXXXX` 形式写出
 * （见 `symbols.js` 的 `unescapeUnicodeEscapes`）。即便运行环境缺少 GBK 解码器、
 * 退回 latin1，这些转义仍是纯 ASCII，因此这条链路在两种解码下都能工作。
 *
 * @param {string} keyword
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<{market:string,code:string,name:string,pinyin:string,type:string}>>}
 */
export async function querySmartbox(keyword, timeoutMs = SMARTBOX_TIMEOUT_MS) {
  const url = `${TENCENT_SMARTBOX_URL}?q=${encodeURIComponent(keyword)}&t=all`;
  const res = await get(url, { headers: { Referer: 'https://gu.qq.com/' } }, timeoutMs);
  const buffer = await res.arrayBuffer();
  const { text } = decodeGbk(buffer);
  return parseSmartboxHints(text);
}

/**
 * 解析 free-stockdb 的日 K 响应。
 * 兼容数组行 `[日期, 开, 高, 低, 收, 量, 额]` 与对象行。
 *
 * @param {unknown} payload
 * @returns {Array<{date: string, open: number, high: number, low: number, close: number, volume: number, amount: number}>}
 */
export function parseFreeStockdbKlines(payload) {
  const rows = pickRows(payload);
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row.length < 5) continue;
      out.push({
        date: normalizeDate(row[0]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
        amount: num(row[6]),
      });
    } else if (row && typeof row === 'object') {
      const o = /** @type {Record<string, unknown>} */ (row);
      const close = num(o.close ?? o['收盘'] ?? o.c);
      if (!close) continue;
      out.push({
        date: normalizeDate(o.date ?? o['日期'] ?? o.time ?? o.trade_date),
        open: num(o.open ?? o['开盘'] ?? o.o) || close,
        high: num(o.high ?? o['最高'] ?? o.h) || close,
        low: num(o.low ?? o['最低'] ?? o.l) || close,
        close,
        volume: num(o.volume ?? o['成交量'] ?? o.vol ?? o.v),
        amount: num(o.amount ?? o['成交额'] ?? o.turnover),
      });
    }
  }
  return out.filter((k) => k.close > 0);
}

/** 在任意嵌套结构中定位「行数组」 */
function pickRows(payload) {
  if (Array.isArray(payload)) {
    if (!payload.length) return [];
    const first = payload[0];
    if (Array.isArray(first) || (first && typeof first === 'object')) return payload;
    return [];
  }
  if (payload && typeof payload === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (payload);
    for (const key of ['data', 'result', 'list', 'rows', 'values', 'kline']) {
      if (key in obj) {
        const rows = pickRows(obj[key]);
        if (rows.length) return rows;
      }
    }
    for (const value of Object.values(obj)) {
      const rows = pickRows(value);
      if (rows.length) return rows;
    }
  }
  return [];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 日期归一化：20260623 / 20260623161456 / 2026-06-23 / 时间戳 → YYYY-MM-DD */
function normalizeDate(v) {
  const s = String(v ?? '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // 腾讯快照的时间戳是 14 位 `yyyyMMddHHmmss`。必须先于下面的毫秒分支判断：
  // 14 位数字同样满足「> 1e11」，落到 `new Date(ms)` 会被当成毫秒时间戳，
  // 得到一个 2611 年的日期，且**不会报错**，属于静默错值。
  if (/^\d{14}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (Number.isFinite(ms) && ms > 1e11) return new Date(ms).toISOString().slice(0, 10);
  return '';
}

/**
 * 解析腾讯日 K 响应。
 * 结构：`{ data: { sh600702: { qfqday: [[日期,开,收,高,低,量], ...], qt: {...} } } }`
 * ⚠️ 腾讯的顺序是 **开/收/高/低**，与 free-stockdb 的 开/高/低/收 不同，必须逐列映射。
 *
 * 两个单位/字段陷阱（2026-09-27 修）：
 * 1. **第 6 列成交量单位是「手」**（1 手 = 100 股），不是股。
 * 2. **腾讯日 K 完全不返回成交额** —— 六列里根本没有它。
 *    好在同一个响应体内就带着 `qt` 快照（成交额在 `parts[35]`），直接借用即可，
 *    不必为此再发一次请求。只补**最后一天**：历史成交额这个源给不出，
 *    硬用「量 × 均价」估一个值会让人以为它是真数据。
 *
 * @param {unknown} payload
 * @param {string} symbol 形如 sh600702
 */
export function parseTencentKlines(payload, symbol) {
  const node = payload?.data?.[symbol];
  if (!node) return { klines: [], name: '' };
  const rows = node.qfqday ?? node.day ?? node.hfqday ?? [];
  const klines = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const close = num(row[2]);
    if (!close) continue;
    const open = num(row[1]);
    const high = num(row[3]);
    const low = num(row[4]);
    klines.push({
      date: normalizeDate(row[0]),
      open,
      // 兜底：腾讯偶有停牌日高低为 0
      high: high || Math.max(open, close),
      low: low || Math.min(open, close),
      close,
      volume: num(row[5]),
      amount: 0,
    });
  }

  // 名称取自 qt 快照（避免为拿一个名字再发一次请求）
  const qt = node.qt?.[symbol];
  const name = Array.isArray(qt) ? String(qt[1] ?? '') : '';

  // 用同一份 qt 快照把**最后一天**的成交额补齐。
  // 必须核日期：`qt` 永远反映最近一个交易日，若最后一条 K 线不是同一天
  // （停牌、数据滞后），把今天的成交额贴到昨天的 K 线上就是错上加错。
  if (Array.isArray(qt) && klines.length) {
    const last = klines[klines.length - 1];
    const qtDate = normalizeDate(qt[30]);
    if (qtDate && qtDate === last.date) {
      const amount = pickTencentAmount(qt);
      if (amount > 0) last.amount = amount;
    }
  }

  return { klines, name };
}

/**
 * 创建行情代理服务。
 * @param {{ freeStockdbBase?: string, fetchImpl?: typeof fetch, probeCacheMs?: number, now?: () => number }} [options]
 */
export function createStockService(options = {}) {
  const base = (options.freeStockdbBase || DEFAULT_FREE_STOCKDB_BASE).replace(/\/+$/, '');
  const probeCacheMs = options.probeCacheMs ?? PROBE_CACHE_MS;
  const nowFn = options.now ?? Date.now;

  let probeCache = { at: 0, available: false, error: '' };

  /**
   * 代码 → 名称 的进程内缓存。
   *
   * 为什么必须有：free-stockdb 的日 K 表**不含股票名称**，走主源时若不反查，
   * 前端只能显示一串数字代码。而反查要走一次网络，所以用长缓存（12h）兜住重复访问。
   */
  const nameCache = new Map();
  /** 同一代码的并发反查去重：避免列表里 6 只股票同时打 6 次同样的请求 */
  const nameInflight = new Map();
  /** 关键词 → 联想结果 的短缓存 */
  const smartboxCache = new Map();

  /**
   * 反查股票名称，**永不抛错**。
   *
   * 名称属于「锦上添花」的信息：拿不到时前端会退回显示代码，
   * 但如果让它把整个行情请求带崩，就是拿次要信息毁掉主要信息。
   * 因此这里全程 try/catch + 短超时，失败返回空串。
   *
   * @param {string} code 6 位代码
   * @returns {Promise<string>}
   */
  async function resolveName(code) {
    const key = String(code ?? '').trim();
    if (!detectMarket(key)) return '';

    const cached = nameCache.get(key);
    if (cached && nowFn() - cached.at < NAME_CACHE_MS) return cached.name;
    // 已有同代码请求在飞 → 复用，不再发一次
    const inflight = nameInflight.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      let name = '';
      // 联想接口最省事：它直接支持用代码查，且返回的就是标准简称
      try {
        const hits = await querySmartbox(key, NAME_LOOKUP_TIMEOUT_MS);
        const exact = hits.find((h) => h.code === key && isAShareQuotable(h));
        name = exact?.name ?? '';
      } catch {
        // 忽略，走下面的快照兜底
      }
      // 快照兜底的字段更权威（含市场前缀校验），但代价是一次完整行情请求
      if (!name) {
        try {
          const snap = await snapshotFromTencent(key);
          name = snap.name || '';
        } catch {
          // 两个通道都失败：安静返回空串，由调用方决定如何展示
        }
      }
      if (name) nameCache.set(key, { at: nowFn(), name });
      return name;
    })().finally(() => {
      nameInflight.delete(key);
    });

    nameInflight.set(key, task);
    return task;
  }

  /** 探测 free-stockdb 是否可用（带缓存） */
  async function probe(force = false) {
    if (!force && nowFn() - probeCache.at < probeCacheMs) return probeCache;
    const url = `${base}/?cmd=get&t=${encodeURIComponent('日k:600702')}`;
    try {
      await get(url, {}, PROBE_TIMEOUT_MS);
      probeCache = { at: nowFn(), available: true, error: '' };
    } catch (err) {
      probeCache = {
        at: nowFn(),
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return probeCache;
  }

  /** 从 free-stockdb 取日 K */
  async function fromFreeStockdb(code, limit, date) {
    const t = date ? `日k:${code}:${date}` : `日k:${code}`;
    const url = `${base}/?cmd=get&t=${encodeURIComponent(t)}`;
    const res = await get(url);
    const payload = await res.json();
    const klines = parseFreeStockdbKlines(payload).slice(-limit);
    if (!klines.length) throw new Error('free-stockdb 返回数据为空或字段未识别');
    return klines;
  }

  /** 从腾讯取实时快照（GBK → UTF-8） */
  async function snapshotFromTencent(code) {
    const symbol = toTencentSymbol(code);
    const res = await get(TENCENT_SNAPSHOT_URL + symbol, {
      headers: { Referer: 'https://gu.qq.com/' },
    });
    const buffer = await res.arrayBuffer();
    const { text, encoding } = decodeGbk(buffer);
    const parsed = parseTencentSnapshot(text, symbol);
    if (!parsed) throw new Error('腾讯快照解析失败');
    return { ...parsed, encoding };
  }

  /** 从腾讯取日 K */
  async function klinesFromTencent(code, limit) {
    const symbol = toTencentSymbol(code);
    const url = `${TENCENT_KLINE_URL}?param=${symbol},day,,,${limit},qfq`;
    const res = await get(url, { headers: { Referer: 'https://gu.qq.com/' } });
    const payload = await res.json();
    const { klines, name } = parseTencentKlines(payload, symbol);
    if (!klines.length) throw new Error('腾讯日 K 返回数据为空');
    return { klines, name: name || code };
  }

  return {
    base,
    probe,

    /**
     * 取实时快照，自动在双源间回退。
     * @param {string} code 6 位股票代码
     */
    async quote(code) {
      const detected = detectMarket(code);
      if (!detected) {
        return { ok: false, code: 'INVALID_CODE', message: `无法识别的股票代码：${code}` };
      }

      const primary = await probe();
      if (primary.available) {
        try {
          const klines = await fromFreeStockdb(code, 2);
          const last = klines[klines.length - 1];
          const prev = klines.length > 1 ? klines[klines.length - 2] : last;
          return {
            ok: true,
            source: 'free-stockdb',
            fallbackUsed: false,
            data: {
              code,
              // free-stockdb 只给数字，名称需另行反查（见 resolveName）
              name: await resolveName(code),
              price: last.close,
              prevClose: prev.close,
              change: round2(last.close - prev.close),
              changePct: prev.close
                ? round2(((last.close - prev.close) / prev.close) * 100)
                : 0,
              open: last.open,
              high: last.high,
              low: last.low,
              volume: last.volume,
              amount: last.amount,
              date: last.date,
            },
          };
        } catch (err) {
          // 主源可用性探测通过但取数失败 → 继续走回退，并记录原因
          probeCache = { at: nowFn(), available: false, error: String(err?.message ?? err) };
        }
      }

      try {
        const snap = await snapshotFromTencent(code);
        return {
          ok: true,
          source: 'tencent',
          fallbackUsed: true,
          fallbackReason: primary.available
            ? 'free-stockdb 取数失败'
            : `free-stockdb 不可达（${primary.error || '未启动'}）`,
          data: {
            code,
            name: snap.name,
            price: snap.price,
            prevClose: snap.prevClose,
            change: snap.change,
            changePct: snap.changePct,
            open: snap.open,
            high: snap.high,
            low: snap.low,
            volume: snap.volume,
            amount: snap.amount,
            amplitude: snap.amplitude,
            date: snap.date,
          },
        };
      } catch (err) {
        return {
          ok: false,
          code: 'ALL_SOURCES_FAILED',
          message: `free-stockdb 与腾讯源均不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    /**
     * 取日 K 序列，自动在双源间回退。
     * @param {string} code
     * @param {number} limit
     * @param {string} [date] free-stockdb 的单日查询（YYYYMMDD）
     */
    async klines(code, limit = 120, date) {
      const detected = detectMarket(code);
      if (!detected) {
        return { ok: false, code: 'INVALID_CODE', message: `无法识别的股票代码：${code}` };
      }

      const primary = await probe();
      if (primary.available) {
        try {
          const klines = await fromFreeStockdb(code, limit, date);
          return {
            ok: true,
            source: 'free-stockdb',
            fallbackUsed: false,
            // 主源没有名称字段，这里补一次反查，否则前端只剩代码可显示
            data: { code, name: await resolveName(code), klines },
          };
        } catch (err) {
          probeCache = { at: nowFn(), available: false, error: String(err?.message ?? err) };
        }
      }

      try {
        const { klines, name } = await klinesFromTencent(code, limit);
        return {
          ok: true,
          source: 'tencent',
          fallbackUsed: true,
          fallbackReason: primary.available
            ? 'free-stockdb 取数失败'
            : `free-stockdb 不可达（${primary.error || '未启动'}）`,
          data: { code, name, klines },
        };
      } catch (err) {
        return {
          ok: false,
          code: 'ALL_SOURCES_FAILED',
          message: `free-stockdb 与腾讯源均不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    /**
     * 按关键词搜索标的（股票名称 / 拼音简写 / 代码均可）。
     *
     * 数据来自腾讯联想接口 —— 它是「输入框边打边出」的原生能力，
     * 比自建一张全市场代码表要轻得多，也不需要额外维护行情快照。
     *
     * 两道过滤是刻意的：
     * 1. **只保留 A 股个股**（`GP-A` + 沪深北）。本站行情终端的取数链路
     *    （`detectMarket`、free-stockdb 日 K、腾讯日 K）只支持 6 位 A 股代码，
     *    放行港美股会让用户选中一个必然取不到数的条目。
     * 2. **按代码去重**。联想结果里同一标的可能因名称/拼音两条路径重复出现。
     *
     * @param {string} keyword
     * @returns {Promise<{ ok: true, keyword: string, items: Array<{code:string,name:string,market:string,marketLabel:string,pinyin:string}>, source: string, message?: string }>}
     */
    async search(keyword) {
      const kw = String(keyword ?? '').trim();
      if (!kw) return { ok: true, keyword: '', items: [], source: 'tencent' };

      const cached = smartboxCache.get(kw);
      if (cached && nowFn() - cached.at < SMARTBOX_CACHE_MS) {
        return { ok: true, keyword: kw, items: cached.items, source: 'tencent', message: cached.message };
      }

      let hits = [];
      let message;
      try {
        hits = await querySmartbox(kw);
      } catch (err) {
        message = `联想接口不可用：${err instanceof Error ? err.message : String(err)}`;
      }

      const seen = new Set();
      const items = [];
      for (const hit of hits) {
        if (!isAShareQuotable(hit)) continue;
        if (seen.has(hit.code)) continue;
        seen.add(hit.code);
        items.push({
          code: hit.code,
          name: hit.name,
          market: hit.market,
          marketLabel:
            hit.market === 'sh' ? '上交所' : hit.market === 'sz' ? '深交所' : '北交所',
          pinyin: hit.pinyin,
        });
        if (items.length >= SMARTBOX_MAX_ITEMS) break;
      }

      // 命中的名称顺手写进名称缓存：用户搜索后立刻会去取这只股票的数据，
      // 预先填好可以省掉一次反查请求。
      for (const item of items) {
        if (!nameCache.has(item.code)) nameCache.set(item.code, { at: nowFn(), name: item.name });
      }

      smartboxCache.set(kw, { at: nowFn(), items, message });
      return { ok: true, keyword: kw, items, source: 'tencent', message };
    },

    /** 数据源状态，供 /api/stock/status 展示 */
    async status() {
      const p = await probe(true);
      return {
        primary: { id: 'free-stockdb', base, available: p.available, error: p.error || null },
        fallback: { id: 'tencent', available: true, note: '实时快照为 GBK 编码，已转 UTF-8' },
      };
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
