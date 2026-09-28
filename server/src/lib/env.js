/**
 * 环境变量与路径解析。
 *
 * 设计要点：
 * - **零依赖**：不引入 dotenv，自己解析 `server/.env`，保持后端「轻量、易维护」。
 * - 已存在的系统环境变量优先级高于 `.env`，方便容器/服务管理器注入。
 * - 所有相对路径都有明确解析基准：`DB_PATH` 相对 server/，`MATERIALS_DIR` 相对项目根。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/ 目录绝对路径 */
export const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

/** 项目根目录绝对路径（前端所在的目录） */
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

/**
 * 解析 `server/.env`，返回键值对。
 * 语法支持：`KEY=value`、`#` 注释、`export KEY=value`、单/双引号包裹的值。
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 构建一份「已合并 .env 与真实环境变量」的配置取值器。
 * 真实环境变量优先，其次 `.env`，最后回落到传入的默认值。
 *
 * @param {{ envFile?: string, processEnv?: Record<string, string | undefined> }} [options]
 */
export function createEnv(options = {}) {
  const envFile = options.envFile ?? path.join(SERVER_DIR, '.env');
  const fileVars = parseEnvFile(envFile);
  const processEnv = options.processEnv ?? process.env;

  const get = (key, fallback = '') => {
    const fromProcess = processEnv[key];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
    const fromFile = fileVars[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return fallback;
  };

  return {
    /** 原始字符串读取 */
    get,
    /** 整数读取，非法值返回默认值 */
    int(key, fallback) {
      const n = Number.parseInt(get(key, ''), 10);
      return Number.isFinite(n) ? n : fallback;
    },
    /** 布尔读取：1/true/yes/on 视为真 */
    bool(key, fallback = false) {
      const v = get(key, '').toLowerCase();
      if (!v) return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v);
    },
    /** 逗号分隔的字符串列表 */
    list(key, fallback = []) {
      const raw = get(key, '').trim();
      if (!raw) return fallback;
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    /** 是否已提供 .env 文件（供 README / 启动日志提示） */
    hasEnvFile: existsSync(envFile),
    envFile,
  };
}

/**
 * 把配置里的相对路径解析为绝对路径。
 * @param {string} target 可能是相对路径
 * @param {string} base 相对路径的解析基准目录
 */
export function resolvePath(target, base) {
  if (!target) return base;
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target);
}

/**
 * 生成后端运行时配置对象。
 * @param {ReturnType<typeof createEnv>} env
 */
export function buildConfig(env) {
  const dbPath = resolvePath(env.get('DB_PATH', './data/fia.db'), SERVER_DIR);
  // ⚠️ 基准必须是 SERVER_DIR：默认值 `../资料分享模块素材` 里的 `..` 就是要跳出 server/。
  //    若以 PROJECT_ROOT 为基准会解析到「桌面/资料分享模块素材」，扫描脚本将找不到文件。
  const materialsDir = resolvePath(
    env.get('MATERIALS_DIR', '../资料分享模块素材'),
    SERVER_DIR
  );

  return {
    port: env.int('PORT', 8787),
    host: env.get('HOST', '127.0.0.1'),
    dbPath,
    materialsDir,
    /**
     * 作品元数据覆写表（sidecar JSON）的位置。
     *
     * 必须与 `materialsDir` 成对配置：它按**相对素材目录的路径**记录覆写
     * （分类、访问级别、作者…），指向另一份素材的覆写表毫无意义。
     * 早先它是写死的绝对路径，于是测试/第二实例会往生产那张表里写
     * —— 表现为生产覆写表里出现一批指不到任何文件的路径。
     *
     * 相对路径以 `server/` 为基准，默认落在 `server/data/production-meta.json`。
     */
    resourceMetaPath: resolvePath(
      env.get('RESOURCE_META_PATH', './data/production-meta.json'),
      SERVER_DIR
    ),
    cookieName: env.get('COOKIE_NAME', 'fia_session'),
    sessionTtlHoursAdmin: env.int('SESSION_TTL_HOURS_ADMIN', 168),
    sessionTtlHoursViewer: env.int('SESSION_TTL_HOURS_VIEWER', 24),
    login: {
      maxFails: env.int('LOGIN_MAX_FAILS', 5),
      windowMs: env.int('LOGIN_WINDOW_MS', 600_000),
      lockMs: env.int('LOGIN_LOCK_MS', 900_000),
    },
    corsOrigins: env.list('CORS_ORIGINS', [
      'http://127.0.0.1:5199',
      'http://localhost:5199',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]),
    news: {
      refreshMs: env.int('NEWS_REFRESH_MS', 86_400_000),
      keepDays: env.int('NEWS_KEEP_DAYS', 7),
    },
    viewerDefaultDays: env.int('SEED_VIEWER_DAYS', 30),
    /**
     * 是否信任反代下发的 `X-Forwarded-For`。
     *
     * **默认 false，且不应轻易打开**。XFF 是客户端可伪造的普通请求头，
     * 而它同时决定了「登录限流的 IP 维度」与「点赞指纹」—— 一旦无条件取信，
     * 换 IP 伪造值即可绕过限流与点赞去重（均已实测复现）。
     *
     * 仅当站点确实挂在**可信**反向代理（Nginx / 云 SLB）之后、
     * 且该代理会覆写而非追加 XFF 时，才设为 true。
     */
    trustProxy: env.bool('TRUST_PROXY', false),
  };
}
