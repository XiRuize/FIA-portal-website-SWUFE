/**
 * HTTP 基础设施：请求解析、响应封装、Cookie、CORS。
 *
 * 全部基于 Node 原生 `http` 与 Web 标准（URL / Headers / ReadableStream），
 * 不引入 express/hono —— 需求规模用不着框架，少一层依赖就少一处维护点。
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, unlinkSync } from 'node:fs';

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
 * 取客户端 IP。
 *
 * ## 为什么默认**不**信 `X-Forwarded-For`
 *
 * XFF 是**客户端可以随意伪造**的普通请求头。早先这里无条件取它的第一段，
 * 而同一个值同时喂给了两个安全机制，于是两者一起失守（实测复现）：
 *
 * - **登录限流**：限流按 `u:<账号>` + `ip:<IP>` 两个维度计数。伪造 XFF 后
 *   「换账号 + 换伪造 IP」连打 12 次，0 次被拦 —— `ip:` 维度名存实亡，
 *   撞库者只需轮换账号名即可无限尝试；
 * - **点赞去重**：点赞指纹 = HMAC(IP + UserAgent)。伪造 IP 连点同一条资料 5 次，
 *   likes 从 1 涨到 6，去重被完全绕过。
 *
 * 因此默认只认 `socket.remoteAddress`（TCP 层地址，伪造不了）。
 * 只有当部署方**明确知道**自己挂在可信反代（Nginx / 云负载均衡）后面时，
 * 才通过 `TRUST_PROXY=1` 打开 XFF 读取 —— 此时反代必须**覆写**而非追加 XFF，
 * 否则仍然是可伪造的。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} [trustProxy] 是否信任 X-Forwarded-For / X-Real-IP
 * @returns {string}
 */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      // 取**最后一段**而不是第一段：可信反代通常是「追加」客户端的伪造值，
      // 只有它自己写进去的最后一跳是可信的。取第一段等于把伪造值当真理。
      const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
  }
  return req.socket?.remoteAddress ?? '';
}

/**
 * 安全解码 URL 路径段。
 *
 * `decodeURIComponent` 遇到畸形的百分号编码（如 `%E4%B8%` 截断的多字节序列、
 * 孤立的 `%`、非法 UTF-8 的 `%FF%FE`）会抛 `URIError`。
 *
 * ⚠️ 这个异常曾在路由匹配阶段抛出，而路由匹配位于请求处理的 `try` 之外，
 * 于是变成 unhandledRejection —— Node 22 默认 `--unhandled-rejections=throw`，
 * **整个后端进程直接退出**。未认证、单请求即可触发，属于远程拒绝服务。
 *
 * 修法：解码失败不抛错，返回 `null` 由调用方决定如何响应。
 * 刻意**不**「失败就退回原串」—— 那会让 `/api/resources/%2e%2e` 这类输入
 * 以字面量形式继续往下走，把问题推到更难排查的地方。宁可明确拒绝。
 *
 * @param {string} value
 * @returns {string | null} 解码结果；输入非法时返回 null
 */
export function safeDecode(value) {
  const raw = String(value ?? '');
  try {
    const decoded = decodeURIComponent(raw);
    // 解码后若仍含 NUL，说明输入在语义上不可能是合法路径段
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * 把请求体**流式**写入磁盘，而不是先读进内存。
 *
 * 上传大文件（研报 PDF 动辄几十 MB）时若先 `Buffer.concat` 再落盘，
 * 单次请求就会占用等量内存，几个并发就能把进程打爆。
 * 这里边收边写，内存占用与文件大小无关。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} destPath 目标绝对路径
 * @param {number} limit 字节上限
 * @returns {Promise<{ bytes: number }>}
 */
export function writeBodyToFile(req, destPath, limit) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    let bytes = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      // 删除写了一半的残文件：素材目录是扫描源，
      // 半截文件会被当成一条正常资料入库，比不落盘更糟。
      try {
        unlinkSync(destPath);
      } catch {
        /* 目标可能尚未创建，忽略 */
      }
      reject(err);
    };

    out.on('error', fail);
    req.on('error', fail);

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        // 用专门的错误码区分「超限」与「网络错误」，以便回 413 而不是 500
        fail(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      // 背压：磁盘写得慢时暂停读，避免内存里堆积整个文件
      if (!out.write(chunk)) req.pause();
    });

    out.on('drain', () => {
      if (!settled) req.resume();
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      out.end(() => resolve({ bytes }));
    });
  });
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
