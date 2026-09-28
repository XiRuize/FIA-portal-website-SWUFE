/**
 * 应用装配：把配置、数据库、各服务与路由串起来，导出一个可测试的 handler。
 *
 * 这里刻意**不直接 listen**，而是返回 `{ handler, ctx, close }`：
 * 测试与 verify 脚本可以用 `http.createServer(handler).listen(0)` 起随机端口，
 * 不必碰真实端口，也不会互相干扰。
 */
import { createServer } from 'node:http';
import { openDatabase } from './lib/db.js';
import * as httpx from './lib/http.js';
import { createAccountService } from './lib/accounts.js';
import { createResourceService, contentDisposition, parseRange } from './lib/resources.js';
import { createNewsService, NEWS_SOURCES } from './lib/news.js';
import { RESTRICTED_CATEGORIES, DEFAULT_RESOURCE_META_URL } from './lib/scan.js';
import { DEFAULT_FREE_STOCKDB_BASE } from './lib/stock.js';
import { fingerprintOf } from './lib/fingerprint.js';
import { parseCookies } from './lib/http.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAccountRoutes } from './routes/accounts.js';
import { createResourceRoutes } from './routes/resources.js';
import { createNewsRoutes, createStockRoutes } from './routes/news.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createPublicRoutes } from './routes/public.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAccessService } from './lib/access.js';
import { createStatsService } from './lib/stats.js';
import { createThrottles } from './lib/throttle.js';
import { createGuards } from './lib/guards.js';

/** 路由表：method + 路径模板（`:name` 为参数段） */
const ROUTES = [
  ['GET', '/api/health', 'health'],

  ['POST', '/api/auth/login', 'auth.login'],
  ['POST', '/api/auth/logout', 'auth.logout'],
  ['GET', '/api/auth/me', 'auth.me'],
  ['GET', '/api/auth/guard', 'auth.guard'],
  ['POST', '/api/auth/password', 'auth.changePassword'],

  // 公开接口（无需登录，带限流）
  ['POST', '/api/access-requests', 'public.requestAccess'],
  ['POST', '/api/stats/pageview', 'public.pageView'],

  // 后台 · 数据
  ['GET', '/api/admin/stats', 'admin.stats'],

  // 后台 · 账号管理（申请队列 + 通知发件箱 + 账号运维）
  ['GET', '/api/admin/access-requests', 'admin.accessRequests'],
  ['POST', '/api/admin/access-requests/:id/approve', 'admin.approveRequest'],
  ['POST', '/api/admin/access-requests/:id/reject', 'admin.rejectRequest'],
  ['GET', '/api/admin/notifications', 'admin.notifications'],
  ['POST', '/api/admin/notifications/:id/sent', 'admin.markNotificationSent'],
  ['GET', '/api/admin/accounts', 'accounts.list'],
  ['POST', '/api/admin/accounts', 'accounts.create'],
  ['POST', '/api/admin/accounts/:id/extend', 'accounts.extend'],
  ['POST', '/api/admin/accounts/:id/reset', 'accounts.reset'],
  ['DELETE', '/api/admin/accounts/:id', 'accounts.revoke'],

  // 后台 · 内容上传与管理
  //
  // ⚠️ 顺序有意为之：`upload-options` / `upload` / `rescan` 这些**字面量段**
  //    必须排在 `:id` 之前。虽然它们此刻靠 method 不同（GET/POST vs PATCH）
  //    不会真的撞上，但路由匹配是「按表顺序取第一个形状相同的」——
  //    一旦将来给 `:id` 加上同名 method，字面量就会被参数段吃掉。
  //    把具体路径写在前面是这个路由表唯一的防御手段。
  ['GET', '/api/admin/resources/upload-options', 'resources.uploadOptions'],
  ['POST', '/api/admin/resources/upload', 'resources.upload'],
  ['POST', '/api/admin/resources/rescan', 'resources.rescan'],
  ['PATCH', '/api/admin/resources/:id', 'resources.updateMeta'],

  ['GET', '/api/resources', 'resources.list'],
  ['GET', '/api/resources/categories', 'resources.categories'],
  ['GET', '/api/resources/:id', 'resources.detail'],
  ['POST', '/api/resources/:id/like', 'resources.like'],
  ['DELETE', '/api/resources/:id/like', 'resources.unlike'],
  ['GET', '/api/resources/:id/download', 'resources.download'],
  ['HEAD', '/api/resources/:id/download', 'resources.download'],
  ['GET', '/api/resources/:id/preview', 'resources.preview'],
  ['HEAD', '/api/resources/:id/preview', 'resources.preview'],

  ['GET', '/api/news/daily', 'news.daily'],
  ['GET', '/api/news/dates', 'news.dates'],
  ['GET', '/api/news/status', 'news.status'],
  ['POST', '/api/news/:id/like', 'news.like'],
  ['DELETE', '/api/news/:id/like', 'news.unlike'],

  ['GET', '/api/stock/kline', 'stock.kline'],
  ['GET', '/api/stock/quote', 'stock.quote'],
  ['GET', '/api/stock/multi', 'stock.multi'],
  ['GET', '/api/stock/search', 'stock.search'],
  ['GET', '/api/stock/status', 'stock.status'],

  ['GET', '/api/settings', 'settings.list'],
  ['PUT', '/api/settings', 'settings.update'],
];

/**
 * 把 `/api/resources/12/like` 匹配到 `['/api/resources/:id/like', {id:'12'}]`。
 *
 * ⚠️ 路径参数一律走 `safeDecode`，**绝不**直接用 `decodeURIComponent`。
 * 后者对畸形百分号编码（`%E4%B8%`、孤立 `%`、`%FF%FE`）会抛 `URIError`；
 * 本函数历史上在请求处理的 `try` 之外被调用，异常逃逸成 unhandledRejection，
 * 直接终止 Node 进程（实测退出码 1）。未认证单请求即可触发。
 *
 * 现在改为：形状匹配成功但参数解码失败时，返回 `malformed: true`，
 * 由调用方回 400 —— 既保住了「不崩溃」，也不会把非法输入当正常参数放行。
 *
 * @returns {{ target: string, params: Record<string, string|null>, malformed: boolean } | null}
 */
function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, target] of ROUTES) {
    if (routeMethod !== method && !(method === 'HEAD' && routeMethod === 'GET')) continue;
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    let malformed = false;
    for (let i = 0; i < patternParts.length; i += 1) {
      const p = patternParts[i];
      const v = pathParts[i];
      if (p.startsWith(':')) {
        // 注意走 `httpx.` 前缀 —— 本文件是命名空间导入（`import * as httpx`），
        // 写成裸名 safeDecode 会得到 ReferenceError，且被 handler 的 catch
        // 统一收成 500，表现为「所有 /api/resources/:id 全挂」这种很误导的现象。
        const decoded = httpx.safeDecode(v);
        if (decoded === null) malformed = true;
        params[p.slice(1)] = decoded;
      } else if (p !== v) {
        matched = false;
        break;
      }
    }
    if (matched) return { target, params, malformed };
  }
  return null;
}

/**
 * 创建应用。
 * @param {{
 *   dbPath?: string,
 *   config: object,
 *   db?: import('node:sqlite').DatabaseSync,
 *   newsSources?: typeof NEWS_SOURCES,
 *   stockService?: object,
 *   fingerprintSecret?: string,
 *   cookieSecure?: boolean,
 *   logger?: (level: string, message: string, extra?: unknown) => void
 * }} options
 */
export function createApp(options) {
  const config = options.config;
  const db = options.db ?? openDatabase(options.dbPath ?? config.dbPath);
  const log = options.logger ?? httpx.log;
  const fingerprintSecret = options.fingerprintSecret ?? process.env.FINGERPRINT_SECRET ?? '';
  const cookieSecure = options.cookieSecure ?? false;

  const accounts = createAccountService(db, config);
  const resources = createResourceService(db, config);
  const news = createNewsService(db, {
    news: config.news,
    sources: options.newsSources,
  });

  /**
   * 受限目录清单。
   *
   * 上传与重扫都要用它决定「默认访问级别」，因此挂在 config 上，
   * 让 `routes/resources.js` 不必再 import 一次常量 ——
   * 两处各持一份副本时，改了 `scan.js` 的白名单会让上传接口用旧规则，
   * 表现是「上传时标成公开的受限目录文件，重扫后变成仅成员」。
   */
  config.restrictedCategories = config.restrictedCategories ?? RESTRICTED_CATEGORIES;

  /**
   * 覆写表路径的兜底。
   *
   * 正常路径来自 `buildConfig()`（`RESOURCE_META_PATH` 环境变量）；
   * 这里兜底是为了「手工拼一个 config 对象」的场景（旧测试、嵌入式调用），
   * 让他们不至于因为缺这个键而写到一个 undefined 路径上。
   *
   * ⚠️ 它与 `materialsDir` 是**成对**的：覆写表按相对素材目录的路径索引，
   * 两者必须指向同一套素材，否则会出现「改了分类，重扫后没变」。
   */
  config.resourceMetaPath = config.resourceMetaPath ?? DEFAULT_RESOURCE_META_URL;

  /**
   * 单文件上传上限。默认 200 MB —— 素材库里最大的文件是几十 MB 的压缩包，
   * 200 MB 有充足余量，同时挡住「误传一个 2 GB 的视频把磁盘写满」。
   */
  config.uploadMaxBytes = config.uploadMaxBytes ?? 200 * 1024 * 1024;

  /**
   * 限流器。可在测试里通过 `options.throttles` 覆盖额度，
   * 便于用很小的上限验证「超限返回 429」而不必真打 60 次请求。
   */
  const throttles = options.throttles ?? createThrottles();

  /** 统计与申请/通知服务 */
  const stats = createStatsService(db);
  const access = createAccessService(db);

  /**
   * 是否信任反向代理下发的 `X-Forwarded-For`。
   * 默认 false —— 见 `http.js` 的 `clientIp()` 注释：无条件取信会让
   * 登录限流的 IP 维度与点赞指纹去重同时失效。
   */
  const trustProxy = options.trustProxy ?? Boolean(config.trustProxy);

  const ctx = {
    db,
    config,
    http: { ...httpx, contentDisposition, parseRange },
    accounts,
    resources,
    news,
    access,
    stats,
    throttles,
    log,
    cors: {},
    cookieSecure,
    trustProxy,

    /**
     * 取客户端 IP（请求级，尊重 trustProxy 配置）。
     *
     * 路由层一律用 `ctx.clientIp(req)` 而不是直接调 `httpx.clientIp`，
     * 这样「是否信代理」只有一个决策点，不会出现某个端点漏配。
     */
    clientIp(req) {
      return httpx.clientIp(req, trustProxy);
    },

    /** 请求级 Cookie 解析（缓存到 req 上，避免重复解析） */
    cookiesOf(req) {
      if (!req.__cookies) req.__cookies = parseCookies(req.headers.cookie);
      return req.__cookies;
    },

    /** 请求级身份解析 */
    identityOf(req) {
      if (req.__identity !== undefined) return req.__identity;
      const token = this.cookiesOf(req)[config.cookieName];
      const resolved = accounts.resolveSession(token);
      req.__identity = resolved
        ? { authenticated: true, account: resolved.account, session: resolved.session }
        : { authenticated: false, account: null, session: null };
      return req.__identity;
    },

    /** 请求级指纹 */
    fingerprintOf(req) {
      if (req.__fingerprint !== undefined) return req.__fingerprint;
      req.__fingerprint = fingerprintOf({
        ip: httpx.clientIp(req, trustProxy),
        userAgent: String(req.headers['user-agent'] ?? ''),
        secret: fingerprintSecret,
      });
      return req.__fingerprint;
    },
  };

  /**
   * 鉴权闸门。必须在 ctx 建好之后创建 —— `createGuards(ctx)` 内部通过
   * `ctx.identityOf` 取身份，是「读取时求值」而不是构造时绑定，
   * 因此这个顺序是安全的，且保证所有路由共用同一套判定文案与状态码。
   */
  ctx.guards = createGuards(ctx);

  const auth = createAuthRoutes(ctx);
  const accountRoutes = createAccountRoutes(ctx);
  const resourceRoutes = createResourceRoutes(ctx);
  const newsRoutes = createNewsRoutes(ctx);
  const stockRoutes = createStockRoutes(ctx, { stockService: options.stockService });
  const settingsRoutes = createSettingsRoutes(ctx);
  const publicRoutes = createPublicRoutes(ctx);
  const adminRoutes = createAdminRoutes(ctx);

  const handlers = {
    health(req, res) {
      httpx.sendOk(
        res,
        {
          status: 'ok',
          service: 'swufe-fia-backend',
          version: '1.0.0',
          time: new Date().toISOString(),
          materialsDir: config.materialsDir,
        },
        200,
        ctx.cors
      );
    },
    auth,
    accounts: accountRoutes,
    resources: resourceRoutes,
    news: newsRoutes,
    stock: stockRoutes,
    settings: settingsRoutes,
    public: publicRoutes,
    admin: adminRoutes,
  };

  /**
   * 解析 `news.daily` 这类目标路径。
   * 注意：目标也可能是不带点号的顶层处理器（如 `health`），
   * 此时直接返回 handlers 上的同名函数，不能去取 undefined 子键。
   */
  function resolveHandler(target) {
    if (!target.includes('.')) {
      const fn = handlers[target];
      return typeof fn === 'function' ? fn : null;
    }
    const [group, name] = target.split('.');
    return handlers[group]?.[name] ?? null;
  }

  /**
   * 主请求处理函数。
   *
   * 所有异常都在此收口，保证「任何情况都不返回 500 空白」，**并且保证
   * 任何单条请求都无法终止进程**。后者是实测踩出来的：早先 `matchRoute`
   * 在 `try` 之外调用，畸形 URL 抛出的 URIError 逃逸成 unhandledRejection，
   * Node 22 默认 `--unhandled-rejections=throw` → 进程退出。
   * 现在解析 URL 与路由匹配都在 `try` 之内。
   */
  const handler = async (req, res) => {
    const started = Date.now();
    const pathnameForLog = String(req.url ?? '/').split('?')[0];

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // CORS：白名单命中才回显 Origin（配合 credentials 不能用 *）
      ctx.cors = httpx.corsHeaders(req, config.corsOrigins);

      if (httpx.isPreflight(req)) {
        res.writeHead(204, {
          ...ctx.cors,
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
        });
        res.end();
        return;
      }

      const matched = matchRoute(req.method, url.pathname);
      if (!matched) {
        // 统一 404：明确告诉调用方端点不存在
        if (url.pathname.startsWith('/api/')) {
          httpx.sendError(res, 404, 'NOT_FOUND', `未知接口：${req.method} ${url.pathname}`, ctx.cors);
        } else {
          httpx.sendError(res, 404, 'NOT_FOUND', '后端只提供 /api/* 接口；前端页面由 Vite 或 Nginx 提供', ctx.cors);
        }
        return;
      }

      // 形状匹配上了，但路径参数里的百分号编码是畸形的 → 明确 400。
      // 不能勉强解码后继续往下走：把非法输入当合法参数，问题会转移到
      // 更深处（例如变成一次莫名的 404 或错查别的记录），排查成本高得多。
      if (matched.malformed) {
        httpx.sendError(
          res,
          400,
          'MALFORMED_PATH',
          '请求路径包含非法的百分号编码，请检查 URL',
          ctx.cors
        );
        return;
      }

      const fn = resolveHandler(matched.target);
      if (!fn) {
        httpx.sendError(res, 501, 'NOT_IMPLEMENTED', `接口未实现：${matched.target}`, ctx.cors);
        return;
      }

      await fn(req, res, matched.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 已开始写响应体时无法再改状态码，只记录日志
      if (res.headersSent) {
        log('error', `响应中途出错 ${req.method} ${pathnameForLog}`, { message });
        res.destroy();
        return;
      }
      if (message === 'INVALID_JSON') {
        httpx.sendError(res, 400, 'INVALID_JSON', '请求体不是合法 JSON', ctx.cors);
        return;
      }
      if (message === 'BODY_TOO_LARGE') {
        httpx.sendError(res, 413, 'BODY_TOO_LARGE', '请求体过大', ctx.cors);
        return;
      }
      log('error', `接口异常 ${req.method} ${pathnameForLog}`, { message });
      httpx.sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误', ctx.cors);
    } finally {
      const ms = Date.now() - started;
      if (pathnameForLog !== '/api/health') {
        log('info', `${req.method} ${pathnameForLog} ${res.statusCode} ${ms}ms`);
      }
    }
  };

  return {
    handler,
    ctx,
    db,
    accounts,
    resources,
    news,
    access,
    stats,
    throttles,
    config,
    /** 启动 HTTP 服务 */
    listen(port = config.port, host = config.host) {
      const server = createServer(handler);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      try {
        db.close();
      } catch {
        // 已关闭时忽略
      }
    },
  };
}

export { DEFAULT_FREE_STOCKDB_BASE, NEWS_SOURCES };
