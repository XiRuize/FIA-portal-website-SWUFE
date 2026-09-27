/**
 * 账号管理路由（仅管理员）。
 * 提供临时浏览账号的创建 / 列出 / 吊销 —— 对应需求三的「有效期管理」。
 */

/**
 * @param {object} ctx
 */
export function createAccountRoutes(ctx) {
  const { accounts, http, config } = ctx;

  /** 统一的管理员前置校验 */
  function requireAdmin(req, res) {
    const identity = ctx.identityOf(req);
    if (!identity.authenticated) {
      http.sendError(res, 401, 'UNAUTHENTICATED', '请先登录', ctx.cors);
      return null;
    }
    if (!identity.account.capabilities.includes('canManageAccounts')) {
      http.sendError(res, 403, 'FORBIDDEN', '当前账号无账号管理权限', ctx.cors);
      return null;
    }
    return identity;
  }

  return {
    /** GET /api/admin/accounts?role=viewer */
    list(req, res) {
      const admin = requireAdmin(req, res);
      if (!admin) return;

      const url = new URL(req.url, 'http://localhost');
      const role = url.searchParams.get('role') || undefined;
      const list = accounts.listAccounts({ role: role ?? undefined });

      return http.sendOk(
        res,
        {
          accounts: list,
          total: list.length,
          /** 顺手返回一个「临时账号默认有效期」参考值，便于前端预填 */
          defaultViewerDays: config.viewerDefaultDays,
        },
        200,
        ctx.cors
      );
    },

    /**
     * POST /api/admin/accounts
     * body: { username, password, role, displayName?, note?, expiresAt?, expiresInDays? }
     *
     * 临时账号（viewer）必须给出 `expiresAt`（ISO 字符串）或 `expiresInDays`。
     */
    async create(req, res) {
      const admin = requireAdmin(req, res);
      if (!admin) return;

      const body = await http.readJsonBody(req);
      let expiresAt = body?.expiresAt ? String(body.expiresAt) : null;

      // 允许用「多少天后过期」这种对使用者更友好的写法
      if (!expiresAt && body?.expiresInDays !== undefined && body?.expiresInDays !== null) {
        const days = Number(body.expiresInDays);
        if (!Number.isFinite(days) || days <= 0) {
          return http.sendError(res, 400, 'INVALID_EXPIRY', '有效天数必须为正数', ctx.cors);
        }
        expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      }

      const result = await accounts.createAccount({
        username: body?.username,
        password: body?.password,
        role: body?.role,
        displayName: body?.displayName,
        note: body?.note,
        expiresAt,
        createdBy: admin.account.username,
      });

      if (!result.ok) {
        const status =
          result.code === 'USERNAME_TAKEN' ? 409 : result.code === 'EXPIRY_IN_PAST' ? 400 : 400;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, { account: result.account }, 201, ctx.cors);
    },

    /** DELETE /api/admin/accounts/:id —— 吊销（软删除，保留审计痕迹） */
    revoke(req, res, params) {
      const admin = requireAdmin(req, res);
      if (!admin) return;

      const id = Number(params.id);
      // 用 Number.isInteger 而非 isFinite：`Number.isFinite(null)` 为 false 但
      // `Number(null) === 0` 是有定义的，必须显式排除 NaN / 非整数
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '账号 ID 非法', ctx.cors);
      }
      if (id === admin.account.id) {
        return http.sendError(res, 400, 'SELF_REVOKE', '不能吊销当前登录的账号', ctx.cors);
      }
      const result = accounts.revokeAccount(id);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, { account: result.account }, 200, ctx.cors);
    },
  };
}
