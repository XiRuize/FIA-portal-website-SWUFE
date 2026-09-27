/**
 * 财经时事路由 + 行情代理路由。
 */
import { createStockService } from '../lib/stock.js';

/**
 * 校验 `YYYY-MM-DD` 是不是一个**真实存在**的日期。
 *
 * 为什么不能只测正则：`2026-13-45`、`2026-02-31` 都符合形状，
 * 但它们不是日期。放行会让查询静默回空集，调用方误以为「那天没有新闻」。
 *
 * 用「回读比对」而不是 Date 解析：`new Date('2026-02-31')` 会自动溢出成
 * 3 月 3 日而不报错，把非法输入悄悄合法化。
 *
 * @param {string} s 形如 YYYY-MM-DD
 */
function isRealCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  // 当月天数：day 0 表示上个月最后一天
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return false;
  // 再确认没有被 Date 归一化（如闰年 2 月 29 日的边界）
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * 财经时事。
 * @param {object} ctx
 */
export function createNewsRoutes(ctx) {
  const { news, http } = ctx;

  return {
    /**
     * GET /api/news/daily?force=0&date=YYYY-MM-DD
     *
     * 返回每日 10 条财经新闻：`{ date, dates, items: [{ id, title, url, publishedAt, likes, liked, source }], stale, fromCache }`
     *
     * - 不传 `date`：返回今天（必要时触发抓取）。
     * - 传 `date`：返回该日存档，**只读缓存不抓取**（历史抓不回来）。
     * - `dates` 始终返回保留窗口内可回看的日期清单，供前端做切换。
     * - 抓取失败时降级返回最近一次缓存并带 `stale: true`；完全不可用时返回 503（**不是 500**）。
     */
    async daily(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const force = url.searchParams.get('force') === '1';
      const dateParam = url.searchParams.get('date');
      const fingerprint = ctx.fingerprintOf(req);

      const hasDate = dateParam !== null && dateParam !== '';
      // 先卡形状再卡真实性：`2026-13-45` 形状对但月份日号非法，
      // 只测正则会让它一路走到查询层、静默返回空集，调用方以为「那天没新闻」。
      const syntaxOk = hasDate && /^\d{4}-\d{2}-\d{2}$/.test(dateParam);
      const isDateValid = syntaxOk && isRealCalendarDate(dateParam);

      if (hasDate && !isDateValid) {
        return http.sendError(
          res,
          400,
          'INVALID_DATE',
          syntaxOk ? '日期不存在（月份或日号超出范围）' : '日期格式应为 YYYY-MM-DD',
          ctx.cors
        );
      }

      const result = isDateValid
        ? news.getByDate(dateParam, { fingerprint })
        : await news.getToday({ fingerprint, force });

      if (result.unavailable) {
        return http.sendError(
          res,
          503,
          'NEWS_UNAVAILABLE',
          result.message || '外部信源不可用，且本地无缓存',
          ctx.cors
        );
      }

      return http.sendOk(
        res,
        {
          date: result.date,
          requestedDate: result.requestedDate ?? result.date,
          items: result.items,
          total: result.items.length,
          /** 保留窗口内可回看的日期，倒序 */
          dates: news.availableDates(),
          /** 保留天数，供前端提示「仅保留最近 N 天」 */
          keepDays: news.keepDays(),
          /** 是否降级到了历史缓存 / 是否为历史存档 */
          stale: Boolean(result.stale),
          fromCache: Boolean(result.fromCache),
          message: result.message ?? null,
        },
        200,
        ctx.cors
      );
    },

    /** GET /api/news/dates —— 可回看的日期清单（供前端快速渲染切换器） */
    dates(req, res) {
      return http.sendOk(
        res,
        { dates: news.availableDates(), keepDays: news.keepDays() },
        200,
        ctx.cors
      );
    },

    /** GET /api/news/status —— 信源健康状态，排查用 */
    status(req, res) {
      return http.sendOk(res, news.status(), 200, ctx.cors);
    },

    /** POST /api/news/:id/like —— 幂等 + 指纹去重 */
    like(req, res, params) {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '新闻 ID 非法', ctx.cors);
      }
      const fingerprint = ctx.fingerprintOf(req);
      const result = news.like(id, fingerprint);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, result, 200, ctx.cors);
    },

    /** DELETE /api/news/:id/like */
    unlike(req, res, params) {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '新闻 ID 非法', ctx.cors);
      }
      const fingerprint = ctx.fingerprintOf(req);
      const result = news.unlike(id, fingerprint);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, result, 200, ctx.cors);
    },
  };
}

/**
 * 行情代理。把浏览器 → 后端的请求转成 后端 → 行情源，规避 HTTPS 页面的混合内容拦截。
 *
 * @param {object} ctx
 * @param {{ stockService?: ReturnType<typeof createStockService> }} [options]
 */
export function createStockRoutes(ctx, options = {}) {
  const { http } = ctx;
  const stock = options.stockService ?? createStockService({
    freeStockdbBase: ctx.config.stockBase,
  });

  return {
    /**
     * GET /api/stock/kline?code=600702&limit=120&date=20260623
     * 响应含 `source` 字段标注本次真正用的数据源。
     */
    async kline(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const code = String(url.searchParams.get('code') ?? '').trim();
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '120', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 5), 500) : 120;
      const date = url.searchParams.get('date') || undefined;

      if (!code) {
        return http.sendError(res, 400, 'MISSING_CODE', '缺少 code 参数', ctx.cors);
      }

      const result = await stock.klines(code, limit, date);
      if (!result.ok) {
        const status = result.code === 'INVALID_CODE' ? 400 : 502;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(
        res,
        {
          code: result.data.code,
          name: result.data.name,
          klines: result.data.klines,
          count: result.data.klines.length,
          /** free-stockdb | tencent */
          source: result.source,
          fallbackUsed: result.fallbackUsed,
          fallbackReason: result.fallbackReason ?? null,
        },
        200,
        ctx.cors
      );
    },

    /**
     * GET /api/stock/quote?code=600702
     * 实时快照。腾讯源为 GBK，后端已转 UTF-8。
     */
    async quote(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const code = String(url.searchParams.get('code') ?? '').trim();
      if (!code) {
        return http.sendError(res, 400, 'MISSING_CODE', '缺少 code 参数', ctx.cors);
      }
      const result = await stock.quote(code);
      if (!result.ok) {
        const status = result.code === 'INVALID_CODE' ? 400 : 502;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(
        res,
        {
          ...result.data,
          source: result.source,
          fallbackUsed: result.fallbackUsed,
          fallbackReason: result.fallbackReason ?? null,
        },
        200,
        ctx.cors
      );
    },

    /**
     * GET /api/stock/multi?codes=600702,000001,601899
     * 批量快照（首页行情条用），并发取数，单个失败不影响其它。
     */
    async multi(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const raw = String(url.searchParams.get('codes') ?? '').trim();
      if (!raw) {
        return http.sendError(res, 400, 'MISSING_CODES', '缺少 codes 参数', ctx.cors);
      }
      const codes = raw
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 50);

      const results = await Promise.all(
        codes.map(async (code) => {
          const result = await stock.quote(code);
          return result.ok
            ? { code, ok: true, ...result.data, source: result.source, fallbackUsed: result.fallbackUsed }
            : { code, ok: false, error: result.message };
        })
      );

      return http.sendOk(
        res,
        {
          quotes: results,
          total: results.length,
          okCount: results.filter((r) => r.ok).length,
        },
        200,
        ctx.cors
      );
    },

    /** GET /api/stock/status —— 探测主源可用性，说明本次会走哪个源 */
    async status(req, res) {
      const status = await stock.status();
      return http.sendOk(
        res,
        {
          ...status,
          activeSource: status.primary.available ? 'free-stockdb' : 'tencent',
        },
        200,
        ctx.cors
      );
    },

    /**
     * GET /api/stock/search?kw=舍得
     *
     * 按**名称 / 拼音简写 / 代码**检索 A 股标的，供行情终端的搜索框做联想。
     * 只返回沪深北 A 股个股 —— 与终端的取数能力保持一致，不给出选不中的候选。
     */
    async search(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const raw = url.searchParams.get('kw') ?? url.searchParams.get('q') ?? '';
      // 关键词截断：联想接口对超长输入没有意义，也避免把参数原样转发出去
      const kw = String(raw).trim().slice(0, 24);
      if (!kw) {
        return http.sendError(res, 400, 'MISSING_KEYWORD', '缺少 kw 参数', ctx.cors);
      }

      const result = await stock.search(kw);
      return http.sendOk(
        res,
        {
          keyword: result.keyword,
          items: result.items,
          total: result.items.length,
          source: result.source,
          message: result.message ?? null,
        },
        200,
        ctx.cors
      );
    },
  };
}
