/**
 * 客户端指纹：用于点赞去重。
 *
 * 设计取舍：
 * - 只做「防误触 + 提高刷赞成本」，不追求身份级唯一（无登录浏览场景下做不到）。
 * - 指纹 = HMAC-SHA256(密钥, `ip|userAgent`)，**不落地原始 IP**，降低隐私风险。
 * - 密钥优先取环境变量 FINGERPRINT_SECRET；未配置时按进程生成随机密钥
 *   （重启后会变化，导致历史点赞指纹失效 —— 正式部署应显式配置）。
 */
import { createHmac, randomBytes } from 'node:crypto';

/** 进程级兜底密钥（未配置 env 时使用） */
const PROCESS_SECRET = randomBytes(32).toString('hex');

/**
 * 计算指纹。
 * @param {{ ip?: string, userAgent?: string, secret?: string }} input
 * @returns {string} 32 位十六进制
 */
export function fingerprintOf({ ip = '', userAgent = '', secret }) {
  const key = secret || PROCESS_SECRET;
  return createHmac('sha256', key)
    .update(`${ip}|${userAgent}`)
    .digest('hex')
    .slice(0, 32);
}

/** 取当前实际使用的密钥（供启动日志提示是否已显式配置） */
export function currentSecret(secret) {
  return secret || PROCESS_SECRET;
}

/** 是否使用了进程级兜底密钥 */
export function usingEphemeralSecret(secret) {
  return !secret;
}
