/**
 * 账号与会话服务（鉴权核心）。
 *
 * 安全要点：
 * 1. 口令只存 scrypt 哈希，接口任何情况下都不回传哈希。
 * 2. 会话 token 为 32 字节随机值，数据库只存其 SHA-256 哈希 —— 即使库泄露也无法直接复用。
 * 3. 每次鉴权都会检查：账号是否被吊销、临时账号是否过期。
 * 4. 登录失败按「账号 + IP」计数，超限锁定，防暴力破解。
 */
import { createHash, randomBytes } from 'node:crypto';
import { plain, plainAll } from './db.js';
import {
  checkPasswordStrength,
  hashPasswordAsync,
  verifyPasswordAsync,
} from './password.js';

/** 角色常量 */
export const ROLE_ADMIN = 'admin';
export const ROLE_VIEWER = 'viewer';

/** 角色对应的能力描述，前端据此做菜单与路由守卫 */
const ROLE_CAPABILITIES = {
  [ROLE_ADMIN]: {
    label: '管理权限账号',
    /** 可进内容管理后台 */
    canManageContent: true,
    /** 可进社团产出（管理视角） */
    canManageProductions: true,
    /** 可浏览受限资料 */
    canViewRestricted: true,
    /** 可管理临时账号 */
    canManageAccounts: true,
    /** 可上传/维护资料 */
    canManageResources: true,
  },
  [ROLE_VIEWER]: {
    label: '临时浏览权限账号',
    canManageContent: false,
    canManageProductions: false,
    canViewRestricted: true,
    canManageAccounts: false,
    canManageResources: false,
  },
};

/** 访客（未登录）的能力 */
export const GUEST_CAPABILITIES = {
  label: '访客',
  canManageContent: false,
  canManageProductions: false,
  canViewRestricted: false,
  canManageAccounts: false,
  canManageResources: false,
};

/** 把权限平铺为字符串列表，前端路由守卫可直接 includes 判断 */
function capabilityKeys(caps) {
  return Object.entries(caps)
    .filter(([key, value]) => key !== 'label' && value === true)
    .map(([key]) => key);
}

const nowIso = () => new Date().toISOString();

/** SHA-256 十六进制摘要（会话 token 与点赞指纹共用） */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 账号服务工厂。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ cookieName: string, sessionTtlHoursAdmin: number, sessionTtlHoursViewer: number, login: { maxFails: number, windowMs: number, lockMs: number } }} config
 */
export function createAccountService(db, config) {
  const stmt = {
    findByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    findById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO accounts
        (username, password_hash, role, display_name, note, expires_at, revoked_at,
         last_login_at, created_at, created_by, updated_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `),
    touchLogin: db.prepare(
      'UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?'
    ),
    setPassword: db.prepare(
      'UPDATE accounts SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?'
    ),
    revoke: db.prepare(
      'UPDATE accounts SET revoked_at = ?, updated_at = ? WHERE id = ?'
    ),
    listAll: db.prepare(
      'SELECT * FROM accounts ORDER BY role DESC, created_at DESC'
    ),
    deleteById: db.prepare('DELETE FROM accounts WHERE id = ?'),

    insertSession: db.prepare(`
      INSERT INTO sessions (token_hash, account_id, created_at, expires_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    findSession: db.prepare(
      'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?'
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionsOf: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
    purgeExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    findAttempt: db.prepare('SELECT * FROM login_attempts WHERE scope = ?'),
    upsertAttempt: db.prepare(`
      INSERT INTO login_attempts (scope, fail_count, first_at, locked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        fail_count = excluded.fail_count,
        first_at = excluded.first_at,
        locked_until = excluded.locked_until
    `),
    clearAttempt: db.prepare('DELETE FROM login_attempts WHERE scope = ?'),
  };

  /**
   * 把一个账号行转成对外可安全暴露的视图（**绝不包含 password_hash**）。
   * @param {Record<string, unknown>} row
   */
  function toPublicAccount(row) {
    if (!row) return null;
    const role = String(row.role);
    const caps = ROLE_CAPABILITIES[role] ?? GUEST_CAPABILITIES;
    const expired = isExpired(row);
    return {
      id: Number(row.id),
      username: String(row.username),
      role,
      displayName: String(row.display_name ?? ''),
      note: String(row.note ?? ''),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
      createdAt: String(row.created_at),
      passwordChangedAt: row.password_changed_at
        ? String(row.password_changed_at)
        : null,
      expired,
      capabilities: capabilityKeys(caps),
      roleLabel: caps.label,
    };
  }

  /** 临时账号是否已过期 */
  function isExpired(row) {
    if (!row?.expires_at) return false;
    return new Date(String(row.expires_at)).getTime() <= Date.now();
  }

  /** 账号当前是否可用（未被吊销、未过期） */
  function isUsable(row) {
    if (!row) return false;
    if (row.revoked_at) return false;
    return !isExpired(row);
  }

  /** 限流 scope：账号维度 + IP 维度各一条，任一超限即拒绝 */
  function attemptScopes(username, ip) {
    const scopes = [];
    if (username) scopes.push(`u:${username.toLowerCase()}`);
    if (ip) scopes.push(`ip:${ip}`);
    return scopes;
  }

  /**
   * 检查是否处于锁定状态。
   * @returns {{ locked: boolean, retryAfterSec?: number }}
   */
  function checkLock(scopes) {
    const now = Date.now();
    let lockedUntil = 0;
    for (const scope of scopes) {
      const row = plain(stmt.findAttempt.get(scope));
      if (!row) continue;
      // 统计窗口已过期则视为清零
      const first = new Date(String(row.first_at)).getTime();
      if (now - first > config.login.windowMs) continue;
      if (row.locked_until) {
        const until = new Date(String(row.locked_until)).getTime();
        if (until > now) lockedUntil = Math.max(lockedUntil, until);
      }
    }
    if (lockedUntil > now) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((lockedUntil - now) / 1000),
      };
    }
    return { locked: false };
  }

  /** 记录一次失败；达到上限则加锁 */
  function recordFailure(scopes) {
    const now = Date.now();
    const nowStr = new Date(now).toISOString();
    for (const scope of scopes) {
      const row = plain(stmt.findAttempt.get(scope));
      const inWindow =
        row && now - new Date(String(row.first_at)).getTime() <= config.login.windowMs;
      const count = inWindow ? Number(row.fail_count) + 1 : 1;
      const firstAt = inWindow ? String(row.first_at) : nowStr;
      const lockedUntil =
        count >= config.login.maxFails
          ? new Date(now + config.login.lockMs).toISOString()
          : null;
      stmt.upsertAttempt.run(scope, count, firstAt, lockedUntil);
    }
  }

  /** 登录成功：清空失败计数 */
  function clearFailures(scopes) {
    for (const scope of scopes) stmt.clearAttempt.run(scope);
  }

  /** 会话有效期（小时）按角色区分 */
  function ttlHoursFor(role) {
    return role === ROLE_ADMIN
      ? config.sessionTtlHoursAdmin
      : config.sessionTtlHoursViewer;
  }

  return {
    isExpired,
    isUsable,
    toPublicAccount,
    attemptScopes,
    checkLock,
    recordFailure,
    clearFailures,
    ttlHoursFor,

    /** 按用户名查账号（返回原始行，仅内部使用） */
    findRawByUsername(username) {
      return plain(stmt.findByUsername.get(String(username ?? '').trim()));
    },

    findRawById(id) {
      return plain(stmt.findById.get(Number(id)));
    },

    /**
     * 登录。
     * @param {{ username: string, password: string, ip: string, userAgent: string }} input
     * @returns {Promise<{ ok: true, token: string, account: object, expiresAt: string }
     *   | { ok: false, code: string, message: string, retryAfterSec?: number }>}
     */
    async login({ username, password, ip, userAgent }) {
      const uname = String(username ?? '').trim();
      const scopes = attemptScopes(uname, ip);

      // 1. 限流检查（在真正校验口令前，避免锁定期间还白白算 scrypt）
      const lock = checkLock(scopes);
      if (lock.locked) {
        return {
          ok: false,
          code: 'TOO_MANY_ATTEMPTS',
          message: `登录失败次数过多，请 ${lock.retryAfterSec} 秒后再试`,
          retryAfterSec: lock.retryAfterSec,
        };
      }

      if (!uname || !password) {
        this.recordFailure(scopes);
        return { ok: false, code: 'INVALID_INPUT', message: '请填写账号与口令' };
      }

      const row = this.findRawByUsername(uname);

      // 2. 账号不存在 / 口令错误 / 账号不可用 —— 统一文案，避免枚举账号
      //    即使账号不存在也做一次哈希计算，抹平响应时间差异。
      const hashToCheck = row?.password_hash ?? DUMMY_HASH;
      const passwordOk = await verifyPasswordAsync(String(password), String(hashToCheck));

      if (!row || !passwordOk) {
        this.recordFailure(scopes);
        return { ok: false, code: 'INVALID_CREDENTIALS', message: '账号或口令不正确' };
      }

      if (row.revoked_at) {
        this.recordFailure(scopes);
        return { ok: false, code: 'ACCOUNT_REVOKED', message: '该账号已被吊销，请联系协会负责人' };
      }

      if (isExpired(row)) {
        this.recordFailure(scopes);
        return {
          ok: false,
          code: 'ACCOUNT_EXPIRED',
          message: '该临时账号已过期，请联系协会负责人重新开通',
        };
      }

      // 3. 签发会话
      this.clearFailures(scopes);
      const token = randomBytes(32).toString('base64url');
      const created = nowIso();
      const ttlMs = this.ttlHoursFor(String(row.role)) * 3600_000;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      stmt.insertSession.run(
        sha256Hex(token),
        Number(row.id),
        created,
        expiresAt,
        String(userAgent ?? '').slice(0, 300),
        String(ip ?? '')
      );
      stmt.touchLogin.run(created, created, Number(row.id));

      return {
        ok: true,
        token,
        expiresAt,
        account: toPublicAccount({ ...row, last_login_at: created }),
      };
    },

    /** 登出：删除当前会话 */
    logout(token) {
      if (!token) return false;
      const info = stmt.deleteSession.run(sha256Hex(token));
      return Number(info.changes) > 0;
    },

    /**
     * 用 token 解析当前身份。
     * @param {string} token
     * @returns {{ account: object, session: object } | null}
     */
    resolveSession(token) {
      if (!token) return null;
      const session = plain(
        stmt.findSession.get(sha256Hex(token), nowIso())
      );
      if (!session) return null;
      const row = this.findRawById(Number(session.account_id));
      if (!isUsable(row)) {
        // 账号已吊销/过期时顺手清掉这条会话
        stmt.deleteSession.run(sha256Hex(token));
        return null;
      }
      return { account: toPublicAccount(row), session };
    },

    /** 修改口令（需校验旧口令）。成功后吊销该账号的其它会话。 */
    async changePassword({ accountId, oldPassword, newPassword, keepToken }) {
      const row = this.findRawById(accountId);
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '账号不存在' };

      const ok = await verifyPasswordAsync(String(oldPassword ?? ''), String(row.password_hash));
      if (!ok) return { ok: false, code: 'INVALID_CREDENTIALS', message: '原口令不正确' };

      const strength = checkPasswordStrength(newPassword);
      if (!strength.ok) return { ok: false, code: 'WEAK_PASSWORD', message: strength.reason };

      const hash = await hashPasswordAsync(String(newPassword));
      const now = nowIso();
      stmt.setPassword.run(hash, now, now, row.id);

      // 改密后其它设备的会话立即失效（保留当前会话，避免把自己踢下线）
      if (keepToken) {
        db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?').run(
          Number(row.id),
          sha256Hex(keepToken)
        );
      } else {
        stmt.deleteSessionsOf.run(Number(row.id));
      }
      return { ok: true };
    },

    /** 管理员创建账号（临时账号必须带过期时间） */
    async createAccount({ username, password, role, displayName, note, expiresAt, createdBy }) {
      const uname = String(username ?? '').trim();
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(uname)) {
        return {
          ok: false,
          code: 'INVALID_USERNAME',
          message: '账号需为 3-32 位字母、数字、点、下划线或连字符',
        };
      }
      if (![ROLE_ADMIN, ROLE_VIEWER].includes(role)) {
        return { ok: false, code: 'INVALID_ROLE', message: '角色只能是 admin 或 viewer' };
      }
      const strength = checkPasswordStrength(password);
      if (!strength.ok) return { ok: false, code: 'WEAK_PASSWORD', message: strength.reason };

      if (role === ROLE_VIEWER) {
        if (!expiresAt) {
          return { ok: false, code: 'EXPIRY_REQUIRED', message: '临时浏览账号必须设置到期时间' };
        }
        if (new Date(String(expiresAt)).getTime() <= Date.now()) {
          return { ok: false, code: 'EXPIRY_IN_PAST', message: '到期时间必须晚于当前时间' };
        }
      }
      if (this.findRawByUsername(uname)) {
        return { ok: false, code: 'USERNAME_TAKEN', message: '该账号已存在' };
      }

      const hash = await hashPasswordAsync(String(password));
      const now = nowIso();
      const info = stmt.insert.run(
        uname,
        hash,
        role,
        String(displayName ?? ''),
        String(note ?? ''),
        expiresAt ? new Date(String(expiresAt)).toISOString() : null,
        now,
        String(createdBy ?? 'system'),
        now,
        now
      );
      const row = this.findRawById(Number(info.lastInsertRowid));
      return { ok: true, account: toPublicAccount(row) };
    },

    /** 列出账号（可按角色过滤），永不返回哈希 */
    listAccounts({ role } = {}) {
      const rows = plainAll(stmt.listAll.all());
      return rows
        .filter((r) => !role || r.role === role)
        .map((r) => toPublicAccount(r));
    },

    /** 吊销账号：立即失效，并删除其全部会话 */
    revokeAccount(id) {
      const row = this.findRawById(id);
      if (!row) return { ok: false, code: 'NOT_FOUND', message: '账号不存在' };
      const now = nowIso();
      stmt.revoke.run(now, now, Number(id));
      stmt.deleteSessionsOf.run(Number(id));
      return { ok: true, account: toPublicAccount({ ...row, revoked_at: now }) };
    },

    /** 清理过期会话（由定时任务调用） */
    purgeExpiredSessions() {
      const info = stmt.purgeExpiredSessions.run(nowIso());
      return Number(info.changes);
    },
  };
}

/**
 * 一个固定的「假哈希」：账号不存在时也走一次校验，抹平响应时间差，防止账号枚举。
 * 明文为随机的不可知值。
 */
const DUMMY_HASH = (() => {
  // 预计算：scrypt$32768$8$1$<salt>$<hash>，内容无关紧要，只要格式合法
  const salt = Buffer.alloc(16, 7);
  return `scrypt$32768$8$1$${salt.toString('base64')}$${Buffer.alloc(64, 3).toString('base64')}`;
})();
