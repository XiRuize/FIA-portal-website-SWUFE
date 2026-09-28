/**
 * 鉴权路由：登录 / 登出 / 当前身份 / 改密。
 *
 * ⚠️ 此处**没有任何接口会返回口令或口令哈希**。前端只提交账号密码、拿回身份与权限。
 */

/**
 * @param {import('../lib/http.js')} http
 * @param {object} ctx 应用上下文（服务实例与配置的集合）
 */
export function createAuthRoutes(ctx) {
  const { accounts, config, http } = ctx;

  return {
    /** POST /api/auth/login */
    async login(req, res) {
      const body = await http.readJsonBody(req);
      // 用 ctx.clientIp：它尊重 TRUST_PROXY 配置，默认只认 TCP 源地址。
      // 直接调 http.clientIp 会退回旧的无条件取信 XFF 行为。
      const ip = ctx.clientIp(req);
      const userAgent = String(req.headers['user-agent'] ?? '');

      const result = await accounts.login({
        username: body?.username,
        password: body?.password,
        ip,
        userAgent,
      });

      if (!result.ok) {
        const status =
          result.code === 'TOO_MANY_ATTEMPTS'
            ? 429
            : result.code === 'ACCOUNT_REVOKED' || result.code === 'ACCOUNT_EXPIRED'
              ? 403
              : 401;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }

      const ttlHours = accounts.ttlHoursFor(result.account.role);
      const cookie = http.buildCookie(config.cookieName, result.token, {
        maxAge: ttlHours * 3600,
        // 生产环境（HTTPS）下应置 true；本地 http 调试必须为 false，否则浏览器不保存
        secure: config.cookieSecure,
        sameSite: 'Lax',
      });

      return http.sendOk(
        res,
        {
          account: result.account,
          expiresAt: result.expiresAt,
          /** 会话时长（小时），前端可做倒计时提示 */
          sessionTtlHours: ttlHours,
        },
        200,
        { ...ctx.cors, 'Set-Cookie': cookie }
      );
    },

    /** POST /api/auth/logout */
    async logout(req, res) {
      const token = ctx.cookiesOf(req)[config.cookieName];
      accounts.logout(token);
      const cookie = http.buildCookie(config.cookieName, '', {
        maxAge: 0,
        secure: config.cookieSecure,
      });
      return http.sendOk(res, { loggedOut: true }, 200, {
        ...ctx.cors,
        'Set-Cookie': cookie,
      });
    },

    /**
     * GET /api/auth/me
     * 无论是否登录都返回 200 —— 前端用它初始化「访客 / 临时 / 管理」三种状态。
     * 未登录时 `authenticated: false`、`role: 'guest'`、capabilities 为空。
     */
    me(req, res) {
      const identity = ctx.identityOf(req);
      return http.sendOk(
        res,
        identity.authenticated
          ? {
              authenticated: true,
              role: identity.account.role,
              account: identity.account,
              capabilities: identity.account.capabilities,
              expiresAt: identity.session.expires_at,
              /** 距过期剩余秒数（临时账号前端可用来提示） */
              expiresInSec: Math.max(
                0,
                Math.floor(
                  (new Date(String(identity.session.expires_at)).getTime() - Date.now()) / 1000
                )
              ),
            }
          : {
              authenticated: false,
              role: 'guest',
              account: null,
              capabilities: [],
              expiresAt: null,
              expiresInSec: null,
            },
        200,
        ctx.cors
      );
    },

    /**
     * GET /api/auth/guard
     * 路由守卫专用最小接口：只回布尔值，响应体极小，便于前端在路由切换时快速判定。
     */
    guard(req, res) {
      const identity = ctx.identityOf(req);
      const query = http.parseQuery(new URL(req.url, 'http://localhost'));
      const required = String(query.require ?? '');

      if (!identity.authenticated) {
        return http.sendOk(
          res,
          {
            allowed: false,
            reason: 'NOT_AUTHENTICATED',
            role: 'guest',
            required: required || null,
          },
          200,
          ctx.cors
        );
      }

      // require=manageContent / canManageAccounts ...
      if (required && !identity.account.capabilities.includes(required)) {
        return http.sendOk(
          res,
          {
            allowed: false,
            reason: 'INSUFFICIENT_CAPABILITY',
            role: identity.account.role,
            required,
          },
          200,
          ctx.cors
        );
      }

      return http.sendOk(
        res,
        {
          allowed: true,
          reason: null,
          role: identity.account.role,
          required: required || null,
        },
        200,
        ctx.cors
      );
    },

    /** POST /api/auth/password —— 修改自己的口令（需原口令） */
    async changePassword(req, res) {
      const identity = ctx.identityOf(req);
      if (!identity.authenticated) {
        return http.sendError(res, 401, 'UNAUTHENTICATED', '请先登录', ctx.cors);
      }
      const body = await http.readJsonBody(req);
      const token = ctx.cookiesOf(req)[config.cookieName];

      const result = await accounts.changePassword({
        accountId: identity.account.id,
        oldPassword: body?.oldPassword,
        newPassword: body?.newPassword,
        keepToken: token,
      });
      if (!result.ok) {
        const status = result.code === 'INVALID_CREDENTIALS' ? 401 : 400;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(
        res,
        { changed: true, note: '其它设备的登录状态已失效' },
        200,
        ctx.cors
      );
    },
  };
}
