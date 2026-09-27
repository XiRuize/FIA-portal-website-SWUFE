#!/usr/bin/env node
/**
 * 后端服务入口。
 *
 * 启动前会做三件事：
 * 1. 加载配置（server/.env + 系统环境变量）
 * 2. 打开/初始化 SQLite（文件不存在时自动建表）
 * 3. 打印一份「可自查」的启动清单：数据文件位置、素材目录是否找到、资料条数、
 *    以及是否配置了指纹密钥
 *
 * 用法：`pnpm start` 或 `node src/index.js`
 */
import { existsSync, statSync } from 'node:fs';
import { buildConfig, createEnv, SERVER_DIR } from './lib/env.js';
import { createApp } from './app.js';
import { log } from './lib/http.js';
import { usingEphemeralSecret } from './lib/fingerprint.js';

const env = createEnv();
const config = buildConfig(env);
config.stockBase = env.get('STOCK_API_BASE', 'http://127.0.0.1:7899');
config.cookieSecure = env.bool('COOKIE_SECURE', false);

const app = createApp({
  config,
  fingerprintSecret: env.get('FINGERPRINT_SECRET', ''),
});

// ---------------------------------------------------------------------------
// 启动自检：把「可能配错的地方」直接摊在启动日志里，而不是等用户撞上 404
// ---------------------------------------------------------------------------
const checks = [];
checks.push(`配置文件      : ${env.hasEnvFile ? env.envFile : '未找到 .env（使用内置默认值）'}`);
checks.push(`数据文件      : ${config.dbPath}`);

const materialsOk = existsSync(config.materialsDir) && statSync(config.materialsDir).isDirectory();
checks.push(
  `素材目录      : ${config.materialsDir} ${materialsOk ? '✓' : '✗ 未找到（资料接口会返回空列表）'}`
);

const resourceCount = app.resources.summary().total;
checks.push(
  `资料条目      : ${resourceCount} 条${
    resourceCount === 0 ? '（尚未扫描，请运行 pnpm run scan:resources）' : ''
  }`
);
checks.push(
  `指纹密钥      : ${
    usingEphemeralSecret(config.fingerprintSecret ?? process.env.FINGERPRINT_SECRET ?? '')
      ? '未配置（进程级随机值：重启后点赞指纹会变，正式部署请设置 FINGERPRINT_SECRET）'
      : '已配置 ✓'
  }`
);
checks.push(`Cookie Secure : ${config.cookieSecure ? 'true（需 HTTPS）' : 'false（本地 http 调试）'}`);

const server = await app.listen();

log('info', '============================================================');
log('info', `西南财经大学金融投资协会 · 自建后端已启动`);
log('info', `监听地址      : http://${config.host}:${config.port}`);
for (const line of checks) log('info', line);
log('info', `健康检查      : http://${config.host}:${config.port}/api/health`);
log('info', '============================================================');

if (!materialsOk) {
  log('error', '素材目录不存在，资料模块将返回空清单。请检查 MATERIALS_DIR 配置。');
}
if (resourceCount === 0 && materialsOk) {
  log('info', '提示：运行 `pnpm run scan:resources`（在 server/ 下）生成资料清单。');
}

// ---------------------------------------------------------------------------
// 定时维护：清理过期会话 + 清理超期新闻缓存
// ---------------------------------------------------------------------------
const HOUR = 3600_000;
const maintenance = setInterval(() => {
  try {
    const sessions = app.accounts.purgeExpiredSessions();
    const news = app.news.cleanup();
    if (sessions || news) {
      log('info', `定时清理完成：过期会话 ${sessions} 条，超期新闻 ${news} 条`);
    }
  } catch (err) {
    log('error', '定时清理失败', { message: err instanceof Error ? err.message : String(err) });
  }
}, 6 * HOUR);
maintenance.unref();

/** 新闻预热：启动后台抓一次（不阻塞启动，失败也不影响服务可用性） */
app.news
  .getToday({})
  .then((r) => {
    if (r.unavailable) log('error', `新闻预热失败：${r.message}`);
    else log('info', `新闻就绪：${r.date} 共 ${r.items.length} 条${r.stale ? '（降级缓存）' : ''}`);
  })
  .catch((err) => log('error', '新闻预热异常', { message: String(err?.message ?? err) }));

/** 优雅退出 */
const shutdown = async (signal) => {
  log('info', `收到 ${signal}，正在关闭…`);
  clearInterval(maintenance);
  await new Promise((resolve) => server.close(resolve));
  app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app, config, SERVER_DIR };
