/**
 * 口令哈希与校验（scrypt，Node 内置 crypto）。
 *
 * 为什么不用 bcrypt：需要原生编译，在 Windows 上会拖累「可独立部署」。
 * scrypt 是 RFC 7914 标准算法，Node 内置、无依赖、抗 GPU 暴力破解。
 *
 * 存储格式（自描述，便于日后升级参数而不破坏旧哈希）：
 *   scrypt$N$r$p$saltBase64$hashBase64
 *
 * 校验使用 `timingSafeEqual`，避免时序侧信道。
 */
import { randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/** 当前参数：N=2^15（32768），r=8，p=1 —— 实测单次约 170ms，安全性/延迟平衡点 */
export const SCRYPT_PARAMS = Object.freeze({
  N: 1 << 15,
  r: 8,
  p: 1,
  keylen: 64,
  // scrypt 内存需求 ≈ 128 * N * r = 32MiB，留出余量避免默认 32MiB 上限报错
  maxmem: 256 * 1024 * 1024,
});

/** 口令最短长度（前端与后端共用同一约束） */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 生成口令哈希（同步）。
 * @param {string} password 明文口令
 * @returns {string} `scrypt$N$r$p$salt$hash`
 */
export function hashPassword(password, params = SCRYPT_PARAMS) {
  if (typeof password !== 'string' || !password) {
    throw new Error('口令不能为空');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验口令。任何解析失败都返回 false，不抛错（避免用异常泄露内部状态）。
 * @param {string} password 待校验明文
 * @param {string} stored 存储的哈希串
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 异步版本，用于服务端请求路径（避免 170ms 的 CPU 计算阻塞事件循环）。
 * @returns {Promise<string>}
 */
export function hashPasswordAsync(password, params = SCRYPT_PARAMS) {
  return new Promise((resolve, reject) => {
    if (typeof password !== 'string' || !password) {
      reject(new Error('口令不能为空'));
      return;
    }
    const salt = randomBytes(16);
    scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, derived) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          [
            'scrypt',
            params.N,
            params.r,
            params.p,
            salt.toString('base64'),
            derived.toString('base64'),
          ].join('$')
        );
      }
    );
  });
}

/**
 * 校验口令（异步版本，服务端登录接口使用）。
 * @returns {Promise<boolean>}
 */
export function verifyPasswordAsync(password, stored) {
  return new Promise((resolve) => {
    if (typeof password !== 'string' || typeof stored !== 'string') {
      resolve(false);
      return;
    }
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      resolve(false);
      return;
    }
    const N = Number.parseInt(parts[1], 10);
    const r = Number.parseInt(parts[2], 10);
    const p = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
      resolve(false);
      return;
    }
    let salt;
    let expected;
    try {
      salt = Buffer.from(parts[4], 'base64');
      expected = Buffer.from(parts[5], 'base64');
    } catch {
      resolve(false);
      return;
    }
    if (!salt.length || !expected.length) {
      resolve(false);
      return;
    }
    scrypt(
      password,
      salt,
      expected.length,
      { N, r, p, maxmem: SCRYPT_PARAMS.maxmem },
      (err, actual) => {
        if (err || actual.length !== expected.length) {
          resolve(false);
          return;
        }
        resolve(timingSafeEqual(actual, expected));
      }
    );
  });
}

/**
 * 演示/评审账号口令豁免清单。
 *
 * 背景：协会站点需要一个「拿到就能进」的评审账号（账号 <已清除> / 口令 <已清除>），
 * 该口令只有 7 位，过不了 `MIN_PASSWORD_LENGTH`。这里**逐一列举**而不是放宽全局下限，
 * 理由有两点：
 * 1. 放宽下限会让所有账号一起变弱，代价远大于收益；
 * 2. 豁免名单是显式的，评审结束后删掉这一行即可收回，无需重新审视所有调用点。
 *
 * ⚠️ 该口令等价于公开口令，只用于演示与评审；正式投放前应改密或吊销该账号。
 */
const DEMO_PASSWORDS = new Set(['<已清除>']);

/**
 * 生成 6 位数字口令 —— 用于「批准临时权限申请」时下发给申请人。
 *
 * ## 为什么允许它绕过全局强度校验
 *
 * `MIN_PASSWORD_LENGTH = 8` 是给**人自己设的口令**定的。这条链路的口令不是人选
 * 的，而是系统随机生成、随通知一起发出、并绑定在一个默认 30 天就作废的
 * viewer 账号上 —— 在这个场景里，长度 6 是需求明确规定的形态
 * （通知文案写死为「随机密码为：（一个六位数字）」）。
 *
 * 因此**不**放宽全局下限，而是让调用方显式声明「这个口令是系统生成的」，
 * 由 `checkPasswordStrength` 的第二个参数逐处开启。这样：
 * - 任何忘记传参的调用点仍然受 8 位约束，不会静默变弱；
 * - 想审计「谁在用短口令」只需搜 `allowGeneratedNumeric` 一个词。
 *
 * `crypto.randomInt` 而非 `Math.random`：后者不是密码学安全随机源，
 * 6 位数字只有 100 万种，用可预测的 PRNG 等于把口令拱手让人。
 *
 * @returns {string} 形如 `483920`
 */
export function generateNumericPassword(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String(randomInt(0, 10));
  }
  // 首位为 0 也无妨（口令不是数字），但全 0 这类极端值仍然合法，不做额外约束
  return out;
}

/** 是否形如「系统生成的数字口令」 */
export function isGeneratedNumericPassword(password) {
  return typeof password === 'string' && /^\d{6}$/.test(password);
}

/**
 * 口令强度校验：只做最小约束（长度 + 非常见弱口令），不引入复杂度地狱。
 *
 * @param {string} password
 * @param {{ allowGeneratedNumeric?: boolean }} [options]
 *   `allowGeneratedNumeric`：仅「系统生成临时口令」这条链路可置 true。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkPasswordStrength(password, options = {}) {
  if (typeof password !== 'string') {
    return { ok: false, reason: `口令至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  const generated = Boolean(options.allowGeneratedNumeric) && isGeneratedNumericPassword(password);
  if (password.length < MIN_PASSWORD_LENGTH && !DEMO_PASSWORDS.has(password) && !generated) {
    return { ok: false, reason: `口令至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  if (password.length > 200) {
    return { ok: false, reason: '口令过长（上限 200 位）' };
  }
  const weak = ['12345678', 'password', 'admin123', 'swufe2026', '88888888'];
  if (weak.includes(password.toLowerCase()) && !DEMO_PASSWORDS.has(password)) {
    return { ok: false, reason: '口令过于常见，请更换' };
  }
  return { ok: true };
}
