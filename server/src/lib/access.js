/**
 * 临时权限申请与通知发件箱。
 *
 * ## 业务链路
 *
 * ```
 * 访客在登录页填手机号
 *        │  POST /api/access-requests（公开，带限流）
 *        ▼
 *   access_requests (status=pending)
 *        │  管理员在「账号管理」批准
 *        ▼
 *   ① 以手机号为账号名创建 viewer 账号，生成 6 位随机口令
 *   ② 写一条 notifications（内容 = 约定的通知文案）
 *        ▼
 *   管理员复制通知内容发出 / 或接入真实通道后自动投递
 * ```
 *
 * ## 为什么通知要落库而不是「直接发」
 *
 * 站点是零第三方依赖的 Node 服务，**没有短信网关**。与其假装发送成功，
 * 不如把「已生成待发送」这个真实状态如实记录：
 * 申请人收不到口令时，管理员能一眼看出是「还没发」还是「发失败了」。
 * 通道抽象成 `channel` 字段，将来接网关只需实现一个读该表的投递器。
 *
 * ## 安全取舍
 *
 * - 申请接口是**公开**的，因此必须限流（见 `throttle.js`），否则会被刷爆申请表；
 * - 同一手机号存在待审申请时**不重复建单**，直接返回已有记录 ——
 *   这既是防刷，也避免管理员看到同一个号码排了 20 条；
 * - 手机号做格式校验（大陆 11 位），杜绝把任意字符串当账号名存进来。
 */

import { plain, plainAll } from './db.js';

/** 批准后临时账号的默认有效期（天） */
export const DEFAULT_APPROVAL_DAYS = 30;

/** 通知文案模板 —— 措辞是需求指定的，改动前先跟协会确认 */
export function buildAccessNotificationText(password) {
  return `您已经获得西南财经大学 金融投资协会的临时浏览权限，账号为您的手机号，随机密码为：${password}`;
}

/**
 * 中国大陆手机号校验。
 *
 * 用 `1[3-9]` 而不是 `1\d{10}`：后者会放行 `10xxxxxxxxx`、`12xxxxxxxxx`
 * 这类不存在号段，让垃圾提交轻易通过格式闸门。
 */
export function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone ?? '').trim());
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createAccessService(db) {
  const stmt = {
    insertRequest: db.prepare(`
      INSERT INTO access_requests
        (phone, name, org, reason, status, ip, fingerprint, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `),
    findPendingByPhone: db.prepare(
      "SELECT * FROM access_requests WHERE phone = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
    ),
    findById: db.prepare('SELECT * FROM access_requests WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM access_requests ORDER BY created_at DESC LIMIT ?'),
    listByStatus: db.prepare(
      'SELECT * FROM access_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ),
    countByStatus: db.prepare(
      'SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status'
    ),
    handle: db.prepare(`
      UPDATE access_requests
         SET status = ?, handled_at = ?, handled_by = ?, account_id = ?, handle_note = ?
       WHERE id = ?
    `),

    insertNotification: db.prepare(`
      INSERT INTO notifications
        (channel, to_addr, subject, body, status, ref_type, ref_id, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `),
    listNotifications: db.prepare(
      'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?'
    ),
    listNotificationsByStatus: db.prepare(
      'SELECT * FROM notifications WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ),
    findNotification: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    markSent: db.prepare(
      "UPDATE notifications SET status = 'sent', sent_at = ?, error = '' WHERE id = ?"
    ),
    markFailed: db.prepare(
      "UPDATE notifications SET status = 'failed', error = ? WHERE id = ?"
    ),
    countNotifications: db.prepare(
      'SELECT status, COUNT(*) AS n FROM notifications GROUP BY status'
    ),
  };

  /** 行 → 对外视图（申请） */
  function toPublicRequest(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      /** 手机号在后台是**必要信息**（它就是账号名），因此照常下发；但访客侧接口绝不回显 */
      phone: String(row.phone),
      /** 打码后的手机号，供日志与对外提示使用 */
      phoneMasked: maskPhone(row.phone),
      name: String(row.name ?? ''),
      org: String(row.org ?? ''),
      reason: String(row.reason ?? ''),
      status: String(row.status),
      createdAt: String(row.created_at),
      handledAt: row.handled_at ? String(row.handled_at) : null,
      handledBy: row.handled_by ? String(row.handled_by) : null,
      accountId: row.account_id === null || row.account_id === undefined
        ? null
        : Number(row.account_id),
      handleNote: String(row.handle_note ?? ''),
    };
  }

  /** 行 → 对外视图（通知） */
  function toPublicNotification(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      channel: String(row.channel),
      to: String(row.to_addr),
      toMasked: maskPhone(row.to_addr),
      subject: String(row.subject ?? ''),
      body: String(row.body),
      status: String(row.status),
      refType: String(row.ref_type ?? ''),
      refId: row.ref_id === null || row.ref_id === undefined ? null : Number(row.ref_id),
      createdAt: String(row.created_at),
      sentAt: row.sent_at ? String(row.sent_at) : null,
      error: String(row.error ?? ''),
    };
  }

  return {
    /* ────────────────────────── 申请 ────────────────────────── */

    /**
     * 提交一条申请。
     *
     * @param {{ phone: string, name?: string, org?: string, reason?: string,
     *           ip?: string, fingerprint?: string }} input
     * @returns {{ ok: true, request: object, duplicate: boolean }
     *   | { ok: false, code: string, message: string }}
     */
    requestAccess({ phone, name, org, reason, ip, fingerprint }) {
      const cleanPhone = String(phone ?? '').trim();
      if (!isValidPhone(cleanPhone)) {
        return {
          ok: false,
          code: 'INVALID_PHONE',
          message: '请填写有效的 11 位手机号',
        };
      }

      // 已有待审申请 → 直接返回那一条，不重复建单。
      // 这不是错误：申请人反复点提交是常见行为，报错反而让人以为没提交上。
      const existing = plain(stmt.findPendingByPhone.get(cleanPhone));
      if (existing) {
        return { ok: true, request: toPublicRequest(existing), duplicate: true };
      }

      const now = new Date().toISOString();
      const info = stmt.insertRequest.run(
        cleanPhone,
        String(name ?? '').trim().slice(0, 60),
        String(org ?? '').trim().slice(0, 120),
        String(reason ?? '').trim().slice(0, 500),
        String(ip ?? '').slice(0, 100),
        String(fingerprint ?? '').slice(0, 100),
        now
      );
      const row = plain(stmt.findById.get(Number(info.lastInsertRowid)));
      return { ok: true, request: toPublicRequest(row), duplicate: false };
    },

    listRequests({ status, limit = 200 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const rows = status
        ? plainAll(stmt.listByStatus.all(String(status), safeLimit))
        : plainAll(stmt.listAll.all(safeLimit));
      return rows.map(toPublicRequest);
    },

    getRequest(id) {
      return toPublicRequest(plain(stmt.findById.get(Number(id))));
    },

    /** 申请状态计数，供后台标签上的角标使用 */
    requestSummary() {
      const out = { pending: 0, approved: 0, rejected: 0, total: 0 };
      for (const row of plainAll(stmt.countByStatus.all())) {
        const key = String(row.status);
        const n = Number(row.n);
        if (key in out) out[key] = n;
        out.total += n;
      }
      return out;
    },

    /**
     * 标记申请为已处理。
     *
     * ⚠️ 只改状态，**不在这里创建账号** —— 账号创建是异步的（scrypt 哈希），
     * 且要处理「手机号已被占用」等分支。编排放在路由层，本方法保持纯粹可测。
     *
     * @param {{ id: number, status: 'approved'|'rejected', handledBy: string,
     *           accountId?: number|null, note?: string }} input
     */
    markHandled({ id, status, handledBy, accountId = null, note = '' }) {
      if (!['approved', 'rejected'].includes(status)) {
        return { ok: false, code: 'INVALID_STATUS', message: '状态只能是 approved 或 rejected' };
      }
      const row = plain(stmt.findById.get(Number(id)));
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '申请不存在' };
      if (row.status !== 'pending') {
        return {
          ok: false,
          code: 'ALREADY_HANDLED',
          message: `该申请已被处理（当前状态：${row.status}）`,
        };
      }
      const now = new Date().toISOString();
      stmt.handle.run(status, now, String(handledBy ?? ''), accountId, String(note ?? ''), Number(id));
      return { ok: true, request: toPublicRequest(plain(stmt.findById.get(Number(id)))) };
    },

    /* ────────────────────────── 通知 ────────────────────────── */

    /**
     * 写一条待发送通知。
     * @param {{ channel?: string, to: string, subject?: string, body: string,
     *           refType?: string, refId?: number|null }} input
     */
    createNotification({ channel = 'outbox', to, subject = '', body, refType = '', refId = null }) {
      const now = new Date().toISOString();
      const info = stmt.insertNotification.run(
        String(channel),
        String(to ?? ''),
        String(subject ?? ''),
        String(body ?? ''),
        String(refType ?? ''),
        refId === null || refId === undefined ? null : Number(refId),
        now
      );
      return toPublicNotification(
        plain(stmt.findNotification.get(Number(info.lastInsertRowid)))
      );
    },

    listNotifications({ status, limit = 200 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const rows = status
        ? plainAll(stmt.listNotificationsByStatus.all(String(status), safeLimit))
        : plainAll(stmt.listNotifications.all(safeLimit));
      return rows.map(toPublicNotification);
    },

    getNotification(id) {
      return toPublicNotification(plain(stmt.findNotification.get(Number(id))));
    },

    notificationSummary() {
      const out = { pending: 0, sent: 0, failed: 0, total: 0 };
      for (const row of plainAll(stmt.countNotifications.all())) {
        const key = String(row.status);
        const n = Number(row.n);
        if (key in out) out[key] = n;
        out.total += n;
      }
      return out;
    },

    /**
     * 标记通知为已发送（管理员手工发出后回填）。
     *
     * 这里刻意**不做真实投递**：本模块不持有任何外部凭据，
     * 也不应在一次 HTTP 请求里同步调用第三方网关（超时/重试都会把请求拖死）。
     */
    markNotificationSent(id) {
      const row = plain(stmt.findNotification.get(Number(id)));
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '通知不存在' };
      stmt.markSent.run(new Date().toISOString(), Number(id));
      return { ok: true, notification: toPublicNotification(plain(stmt.findNotification.get(Number(id)))) };
    },

    markNotificationFailed(id, error) {
      const row = plain(stmt.findNotification.get(Number(id)));
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '通知不存在' };
      stmt.markFailed.run(String(error ?? '').slice(0, 500), Number(id));
      return { ok: true, notification: toPublicNotification(plain(stmt.findNotification.get(Number(id)))) };
    },
  };
}

/**
 * 手机号打码：`13812345678` → `138****5678`。
 *
 * 用途是「能在界面上看着不像明文到处飞」的地方（日志、对外提示）。
 * ⚠️ 后台的账号列表**不打码** —— 那里管理员就是要看真实号码才能联系到人，
 * 打码会让这个面板失去意义。打码只用在「不需要精确识别」的场合。
 */
export function maskPhone(phone) {
  const s = String(phone ?? '');
  if (s.length < 7) return s ? '***' : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}
