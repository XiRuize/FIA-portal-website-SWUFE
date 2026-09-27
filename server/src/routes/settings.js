/**
 * 站点配置路由。
 *
 * ⚠️ 核心安全修复点：**敏感配置项绝不下发访客**。
 * 原前端把整张 settings 表（含 `admin_passcode`）暴露给每一个访客，
 * 等价于把管理口令写在公开页面上。这里按 `secret` 标记做字段级过滤，
 * 仅管理员（且显式传 `?include_secret=1`）才能读到敏感项。
 */
import { plainAll } from '../lib/db.js';

/** 敏感键名（与数据库 secret 列双重保险） */
export const SECRET_KEYS = ['admin_passcode', 'admin_password', 'admin_token', 'jwt_secret'];

/**
 * @param {object} ctx
 */
export function createSettingsRoutes(ctx) {
  const { db, http } = ctx;

  const stmt = {
    all: db.prepare('SELECT key, value, description, secret FROM settings ORDER BY key'),
    upsert: db.prepare(`
      INSERT INTO settings (key, value, description, secret, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = excluded.description,
        updated_at = excluded.updated_at
    `),
  };

  /** 是否敏感（数据库标记 或 命中键名黑名单） */
  const isSecret = (row) => Number(row.secret) === 1 || SECRET_KEYS.includes(String(row.key));

  return {
    /**
     * GET /api/settings
     * 公开接口：只回非敏感项。无论是否登录都不会返回口令类配置。
     */
    list(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const includeSecret = url.searchParams.get('include_secret') === '1';

      const identity = ctx.identityOf(req);
      const canReadSecret =
        includeSecret &&
        identity.authenticated &&
        identity.account.capabilities.includes('canManageContent');

      const rows = plainAll(stmt.all.all());
      const visible = rows.filter((row) => (canReadSecret ? true : !isSecret(row)));

      return http.sendOk(
        res,
        {
          settings: visible.map((row) => ({
            key: String(row.key),
            value: String(row.value ?? ''),
            description: String(row.description ?? ''),
            secret: isSecret(row),
          })),
          /** 被过滤掉的键名（不回值，只回数量，便于排查） */
          filteredSecretCount: rows.length - visible.length,
          total: visible.length,
        },
        200,
        ctx.cors
      );
    },

    /**
     * PUT /api/settings —— 仅管理员。逐键写入。
     * body: { values: { site_name: '...', ... } }
     */
    async update(req, res) {
      const identity = ctx.identityOf(req);
      if (!identity.authenticated) {
        return http.sendError(res, 401, 'UNAUTHENTICATED', '请先登录', ctx.cors);
      }
      if (!identity.account.capabilities.includes('canManageContent')) {
        return http.sendError(res, 403, 'FORBIDDEN', '当前账号无内容管理权限', ctx.cors);
      }

      const body = await http.readJsonBody(req);
      const values = body?.values;
      if (!values || typeof values !== 'object') {
        return http.sendError(res, 400, 'INVALID_BODY', '需要 { values: { key: value } }', ctx.cors);
      }

      const now = new Date().toISOString();
      let written = 0;
      const rejected = [];

      db.exec('BEGIN');
      try {
        for (const [key, value] of Object.entries(values)) {
          const k = String(key);
          // 不允许通过接口改写口令类配置（口令归属账号体系，不放在 settings 里）
          if (SECRET_KEYS.includes(k)) {
            rejected.push(k);
            continue;
          }
          stmt.upsert.run(k, String(value ?? ''), '', 0, now);
          written += 1;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return http.sendOk(res, { written, rejected }, 200, ctx.cors);
    },
  };
}
