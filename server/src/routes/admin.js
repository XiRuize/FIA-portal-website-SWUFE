/**
 * 后台管理接口（「栏目与网站管理」）。
 *
 * 分成三块，与前端左侧子栏目一一对应：
 * - **数据**：`GET /api/admin/stats`
 * - **账号管理**：申请队列的批准/驳回 + 通知发件箱
 * - （内容上传与管理在 `routes/resources.js`，因为它操作的是资料服务）
 *
 * 所有端点都过 `guards.accounts`（`canManageAccounts`），
 * 唯一的例外是 `stats` —— 它给整个后台用，因此只需 `canManageContent`。
 */

import { generateNumericPassword } from '../lib/password.js';
import {
  DEFAULT_APPROVAL_DAYS,
  buildAccessNotificationText,
} from '../lib/access.js';

/**
 * @param {object} ctx
 */
export function createAdminRoutes(ctx) {
  const { http, accounts, access, stats, guards } = ctx;

  /** 从账号列表里剔除敏感字段不该做的事：`toPublicAccount` 已保证不含哈希 */
  function viewerAccounts() {
    return accounts
      .listAccounts({ role: 'viewer' })
      .sort((a, b) => {
        // 排序：仍然可用的排前面；同组内按到期时间升序（快过期的先看到）
        if (a.active !== b.active) return a.active ? -1 : 1;
        const at = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
        const bt = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
        return at - bt;
      });
  }

  return {
    /**
     * GET /api/admin/stats
     *
     * 「数据」面板的唯一数据源。刻意**一次返回全部**，而不是拆成
     * `/stats/views` + `/stats/accounts` 多个端点：面板是一屏同时显示的，
     * 拆开会让首屏产生 3–4 个并发请求，且各块数字来自不同时刻，
     * 站长大致会对不上数（例如「账号数」在两张卡片里不一样）。
     */
    stats(req, res) {
      const admin = guards.admin(req, res);
      if (!admin) return;

      const view = stats.overview();
      const viewers = viewerAccounts();

      return http.sendOk(
        res,
        {
          views: {
            ...view,
            daily: stats.dailySeries(14),
            topPaths: stats.topPaths(8),
          },
          accounts: {
            /** 全部 viewer 账号（含已过期/已吊销），前端自己分档渲染 */
            viewers,
            /** 仍然可用的访客账号 */
            activeViewers: viewers.filter((a) => a.active),
            /** 已过期但未被吊销的 —— 面板要红字提示并可一键延长 */
            expiredViewers: viewers.filter((a) => !a.active && !a.revokedAt),
            admins: accounts.listAccounts({ role: 'admin' }),
          },
          requests: access.requestSummary(),
          notifications: access.notificationSummary(),
          /** 服务端当前时间，前端据此校正倒计时（本机时钟可能不准） */
          serverTime: new Date().toISOString(),
        },
        200,
        ctx.cors
      );
    },

    /* ───────────────────── 临时权限申请队列 ───────────────────── */

    /** GET /api/admin/access-requests?status=pending */
    accessRequests(req, res) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const url = new URL(req.url, 'http://localhost');
      const status = url.searchParams.get('status') || undefined;
      const list = access.listRequests({ status });

      return http.sendOk(
        res,
        {
          requests: list,
          summary: access.requestSummary(),
          /** 默认批准天数，前端预填用 */
          defaultDays: DEFAULT_APPROVAL_DAYS,
        },
        200,
        ctx.cors
      );
    },

    /**
     * POST /api/admin/access-requests/:id/approve
     * body: { days?, displayName?, note? }
     *
     * 批准 = 建账号 + 生成口令 + 写通知。三步里任何一步失败都要能说清断在哪。
     *
     * ## 手机号已被占用怎么办
     *
     * 这是**正常情况**而不是异常：申请人可能半年前拿过账号、过期了又来申请。
     * 此时不该报「账号已存在」把管理员卡住，而应把它当成**续期**：
     * 重置口令 + 延长有效期，然后照常发通知。
     * 否则管理员只能先去别处吊销旧账号，才能回来批准这条申请。
     */
    async approveRequest(req, res, params) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '申请 ID 非法', ctx.cors);
      }

      const request = access.getRequest(id);
      if (!request) {
        return http.sendError(res, 404, 'NOT_FOUND', '申请不存在', ctx.cors);
      }
      if (request.status !== 'pending') {
        return http.sendError(
          res,
          409,
          'ALREADY_HANDLED',
          `该申请已被处理（当前状态：${request.status}）`,
          ctx.cors
        );
      }

      const body = await http.readJsonBody(req);
      const days = Number(body?.days) > 0 ? Number(body.days) : DEFAULT_APPROVAL_DAYS;
      if (days > 3650) {
        return http.sendError(res, 400, 'INVALID_DAYS', '有效期不得超过 3650 天', ctx.cors);
      }

      // 6 位数字口令由系统生成，因此这里显式开启短口令豁免
      const password = generateNumericPassword(6);
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const displayName =
        String(body?.displayName ?? '').trim() ||
        request.name ||
        `访客 ${request.phoneMasked}`;

      let account;
      let reused = false;

      const existing = accounts.findRawByUsername(request.phone);
      if (existing) {
        reused = true;
        /**
         * 已存在同号账号 → 走「续期」路径。
         *
         * ⚠️ 若该账号已被吊销，必须先把 revoked_at 清掉 —— 否则重置了口令、
         * 延长了时间，账号依旧进不去（`isUsable` 会因 revoked_at 直接拒绝），
         * 而管理员在界面上看到的是「已批准、已发通知」，问题极难定位。
         */
        if (existing.revoked_at) {
          accounts.reactivateAccount(Number(existing.id));
        }
        await accounts.resetPassword({
          id: Number(existing.id),
          password,
          allowGeneratedNumeric: true,
        });
        accounts.extendAccount({ id: Number(existing.id), days });
        account = accounts.toPublicAccount(accounts.findRawById(Number(existing.id)));
      } else {
        const created = await accounts.createAccount({
          username: request.phone,
          password,
          role: 'viewer',
          displayName,
          note: request.org ? `申请单位：${request.org}` : '由登录页申请批准',
          expiresAt,
          createdBy: admin.account.username,
          source: 'application',
          phone: request.phone,
          allowGeneratedNumeric: true,
        });
        if (!created.ok) {
          const status = created.code === 'USERNAME_TAKEN' ? 409 : 400;
          return http.sendError(res, status, created.code, created.message, ctx.cors);
        }
        account = created.account;
      }

      const handled = access.markHandled({
        id,
        status: 'approved',
        handledBy: admin.account.username,
        accountId: account.id,
        note: String(body?.note ?? '').slice(0, 500),
      });
      if (!handled.ok) {
        return http.sendError(res, 409, handled.code, handled.message, ctx.cors);
      }

      // 通知内容按需求给定的文案渲染，逐字一致，不在别处再拼一遍
      const notification = access.createNotification({
        channel: 'outbox',
        to: request.phone,
        subject: '西南财经大学金融投资协会 · 临时浏览权限已开通',
        body: buildAccessNotificationText(password),
        refType: 'access_request',
        refId: id,
      });

      return http.sendOk(
        res,
        {
          request: handled.request,
          account,
          /**
           * 口令明文**只在这一刻返回一次**。
           * 库中只存 scrypt 哈希，关掉这个响应就再也取不回来 —— 与
           * AccountManager 的凭据回执是同一套约定。
           */
          issuedPassword: password,
          reused,
          notification,
          notice:
            '口令仅显示这一次，请立即转交申请人。站点未接入短信网关，' +
            '通知已进入「通知发件箱」，请复制内容发送给申请人后标记为已发送。',
        },
        200,
        ctx.cors
      );
    },

    /** POST /api/admin/access-requests/:id/reject  body: { note? } */
    async rejectRequest(req, res, params) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '申请 ID 非法', ctx.cors);
      }
      const body = await http.readJsonBody(req);
      const result = access.markHandled({
        id,
        status: 'rejected',
        handledBy: admin.account.username,
        note: String(body?.note ?? '').slice(0, 500),
      });
      if (!result.ok) {
        return http.sendError(res, result.code === 'NOT_FOUND' ? 404 : 409, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, { request: result.request }, 200, ctx.cors);
    },

    /* ───────────────────────── 通知发件箱 ───────────────────────── */

    /** GET /api/admin/notifications?status=pending */
    notifications(req, res) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const url = new URL(req.url, 'http://localhost');
      const status = url.searchParams.get('status') || undefined;

      return http.sendOk(
        res,
        {
          notifications: access.listNotifications({ status }),
          summary: access.notificationSummary(),
        },
        200,
        ctx.cors
      );
    },

    /** POST /api/admin/notifications/:id/sent —— 管理员转发后回填状态 */
    markNotificationSent(req, res, params) {
      const admin = guards.accounts(req, res);
      if (!admin) return;

      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return http.sendError(res, 400, 'INVALID_ID', '通知 ID 非法', ctx.cors);
      }
      const result = access.markNotificationSent(id);
      if (!result.ok) {
        return http.sendError(res, 404, result.code, result.message, ctx.cors);
      }
      return http.sendOk(res, { notification: result.notification }, 200, ctx.cors);
    },
  };
}
