/**
 * 账号管理路由（仅管理员）。
 *
 * 覆盖临时浏览账号的完整生命周期：
 * - 列出（含剩余有效期）
 * - 新建
 * - **延长**有效期（需求里的「一键延长权限」）
 * - **重置**口令（需求里的「一键重置权限」）
 * - 吊销
 *
 * 鉴权统一走 `guards.accounts`（`canManageAccounts`）。
 * 早先这里各写一份 `requireAdmin`，与其它路由的副本容易漂移，已收敛。
 */

import { generateNumericPassword } from '../lib/password.js';

/**
 * @param {object} ctx
 */
export function createAccountRoutes(ctx) {
  const { accounts, http, config, guards } = ctx;

  return {
    /** GET /api/admin/accounts?role=viewer */
    list(req, res) {
      const admin = guards.accounts(req, res);
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
      const admin = guards.accounts(req, res);
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
        source: 'manual',
      });

      if (!result.ok) {
        const status = result.code === 'USERNAME_TAKEN' ? 409 : 400;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, { account: result.account }, 201, ctx.cors);
    },

    /**
     * POST /api/admin/accounts/:id/extend
     * body: { days?: number }  默认沿用 config.viewerDefaultDays（30）
     *
     * 「一键延长权限」。对**已过期**的账号同样有效 —— 从当前时刻重新起算，
     * 这正是过期后最需要的操作。
     */
    async extend(req, res, params) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '账号 ID 非法', ctx.cors);
      }

      const body = await http.readJsonBody(req);
      const days = Number(body?.days) > 0 ? Number(body.days) : config.viewerDefaultDays;

      const result = accounts.extendAccount({ id, days });
      if (!result.ok) {
        const status =
          result.code === 'NOT_FOUND'
            ? 404
            : result.code === 'ACCOUNT_REVOKED'
              ? 409
              : 400;
        return http.sendError(res, status, result.code, result.message, ctx.cors);
      }
      return http.sendOk(
        res,
        { account: result.account, extendedDays: days },
        200,
        ctx.cors
      );
    },

    /**
     * POST /api/admin/accounts/:id/reset
     * body: { password?, numeric? }
     *
     * 「一键重置权限」。默认生成 6 位数字口令（与申请批准同一形态，
     * 便于通过同一套话术转发给使用者）；管理员也可自带口令。
     *
     * ⚠️ 重置会**清空该账号的全部会话**：否则拿到旧 Cookie 的人继续畅通，
     * 「重置」就成了一句空话。
     */
    async reset(req, res, params) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '账号 ID 非法', ctx.cors);
      }

      const body = await http.readJsonBody(req);
      const provided = body?.password ? String(body.password) : '';
      // 走 6 位数字这条路才开启短口令豁免；管理员自带口令则按常规强度校验
      const generated = provided ? false : true;
      const password = provided || generateNumericPassword(6);

      const result = await accounts.resetPassword({
        id,
        password,
        allowGeneratedNumeric: generated,
      });
      if (!result.ok) {
        return http.sendError(
          res,
          result.code === 'NOT_FOUND' ? 404 : 400,
          result.code,
          result.message,
          ctx.cors
        );
      }

      return http.sendOk(
        res,
        {
          account: result.account,
          /** 明文只回一次；库中只有哈希 */
          issuedPassword: password,
          generated,
          revokedSessions: result.revokedSessions,
        },
        200,
        ctx.cors
      );
    },

    /** DELETE /api/admin/accounts/:id —— 吊销（软删除，保留审计痕迹） */
    revoke(req, res, params) {
      const admin = guards.accounts(req, res);
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
      // `revoked: true` 是为兼容前端既有类型声明（`{ revoked, account }`）而保留的
      return http.sendOk(res, { revoked: true, account: result.account }, 200, ctx.cors);
    },
  };
}
