/**
 * HTTP 基础设施：请求解析、响应封装、Cookie、CORS。
 *
 * 全部基于 Node 原生 `http` 与 Web 标准（URL / Headers / ReadableStream），
 * 不引入 express/hono —— 需求规模用不着框架，少一层依赖就少一处维护点。
 */
import { randomUUID } from 'node:crypto';

/** 请求体大小上限（登录/创建账号等 JSON 接口足够，防止内存打爆） */
const MAX_JSON_BODY = 256 * 1024;

/**
 * 把一个普通对象序列化为 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP 状态码
 * @param {unknown} payload 响应体
 * @param {Record<string, string>} [headers] 附加响应头
 */
export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    // 接口一律不缓存，避免把受保护的响应缓存到中间层
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 统一的成功响应：`{ ok: true, data }` */
export function sendOk(res, data, status = 200, headers = {}) {
  sendJson(res, status, { ok: true, data }, headers);
}

/** 统一的失败响应：`{ ok: false, error: { code, message } }` */
export function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, headers);
}

/** 简单文本响应（健康检查等） */
export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    ...headers,
  });
  res.end(body);
}

/**
 * 解析 Cookie 头为普通对象。
 * @param {string} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 构造 Set-Cookie 值。
 * httpOnly + SameSite=Lax：JS 读不到，跨站表单提交也不会带上，兼顾安全与可用性。
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, path?: string, sameSite?: 'Lax'|'Strict'|'None', secure?: boolean, expires?: Date }} [options]
 */
export function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 生成一个随机的请求 ID，便于日志排查 */
export function requestId() {
  return randomUUID();
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] 字节上限
 * @returns {Promise<unknown>}
 */
export function readJsonBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 解析查询参数为普通对象（同名多值取第一个）。
 * @param {URL} url
 */
export function parseQuery(url) {
  const out = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * 取客户端 IP。优先 X-Forwarded-For 第一段（Nginx 反代场景）。
 * @param {import('node:http').IncomingMessage} req
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.socket?.remoteAddress ?? '';
}

/**
 * 判断来源是否在 CORS 白名单内，是则返回需要下发的 CORS 头。
 *
 * 注意：要让浏览器带上 Cookie，`Access-Control-Allow-Origin` 必须是**具体源**
 * 且 `Access-Control-Allow-Credentials: true`，不能用 `*`。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} allowed 白名单
 * @returns {Record<string, string>}
 */
export function corsHeaders(req, allowed) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return {};
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * 判断请求是否为预检（OPTIONS）。
 */
export function isPreflight(req) {
  return req.method === 'OPTIONS';
}

/** 简易结构化日志 */
export function log(level, message, extra) {
  const stamp = new Date().toISOString();
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${stamp}] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}
