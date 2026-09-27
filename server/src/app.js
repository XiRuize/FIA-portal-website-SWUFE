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
import { DEFAULT_FREE_STOCKDB_BASE } from './lib/stock.js';
import { fingerprintOf } from './lib/fingerprint.js';
import { parseCookies } from './lib/http.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAccountRoutes } from './routes/accounts.js';
import { createResourceRoutes } from './routes/resources.js';
import { createNewsRoutes, createStockRoutes } from './routes/news.js';
import { createSettingsRoutes } from './routes/settings.js';

/** 路由表：method + 路径模板（`:name` 为参数段） */
const ROUTES = [
  ['GET', '/api/health', 'health'],

  ['POST', '/api/auth/login', 'auth.login'],
  ['POST', '/api/auth/logout', 'auth.logout'],
  ['GET', '/api/auth/me', 'auth.me'],
  ['GET', '/api/auth/guard', 'auth.guard'],
  ['POST', '/api/auth/password', 'auth.changePassword'],

  ['GET', '/api/admin/accounts', 'accounts.list'],
  ['POST', '/api/admin/accounts', 'accounts.create'],
  ['DELETE', '/api/admin/accounts/:id', 'accounts.revoke'],

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

/** 把 `/api/resources/12/like` 匹配到 `['/api/resources/:id/like', {id:'12'}]` */
function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, target] of ROUTES) {
    if (routeMethod !== method && !(method === 'HEAD' && routeMethod === 'GET')) continue;
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const p = patternParts[i];
      const v = pathParts[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(v);
      } else if (p !== v) {
        matched = false;
        break;
      }
    }
    if (matched) return { target, params };
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

  const ctx = {
    db,
    config,
    http: { ...httpx, contentDisposition, parseRange },
    accounts,
    resources,
    news,
    log,
    cors: {},
    cookieSecure,

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
        ip: httpx.clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
        secret: fingerprintSecret,
      });
      return req.__fingerprint;
    },
  };

  const auth = createAuthRoutes(ctx);
  const accountRoutes = createAccountRoutes(ctx);
  const resourceRoutes = createResourceRoutes(ctx);
  const newsRoutes = createNewsRoutes(ctx);
  const stockRoutes = createStockRoutes(ctx, { stockService: options.stockService });
  const settingsRoutes = createSettingsRoutes(ctx);

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
   * 所有异常都在此收口，保证「任何情况都不返回 500 空白」。
   */
  const handler = async (req, res) => {
    const started = Date.now();
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

    const fn = resolveHandler(matched.target);
    if (!fn) {
      httpx.sendError(res, 501, 'NOT_IMPLEMENTED', `接口未实现：${matched.target}`, ctx.cors);
      return;
    }

    try {
      await fn(req, res, matched.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'INVALID_JSON') {
        httpx.sendError(res, 400, 'INVALID_JSON', '请求体不是合法 JSON', ctx.cors);
        return;
      }
      if (message === 'BODY_TOO_LARGE') {
        httpx.sendError(res, 413, 'BODY_TOO_LARGE', '请求体过大', ctx.cors);
        return;
      }
      // 已开始写响应体时无法再改状态码，只记录日志
      if (res.headersSent) {
        log('error', `响应中途出错 ${req.method} ${url.pathname}`, { message });
        res.destroy();
        return;
      }
      log('error', `接口异常 ${req.method} ${url.pathname}`, { message });
      httpx.sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误', ctx.cors);
    } finally {
      const ms = Date.now() - started;
      if (url.pathname !== '/api/health') {
        log('info', `${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
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
