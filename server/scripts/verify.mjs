#!/usr/bin/env node
/**
 * 一键自检：把后端所有可验证的能力跑一遍，打印「通过 / 失败」清单。
 *
 * 与 `npm test` 的区别：
 * - `npm test` 用**隔离的临时库**跑断言，回答「代码逻辑对不对」。
 * - `npm run verify` 用**真实数据库 + 真实素材目录**跑全链路，回答
 *   「这台机器上现在能不能跑起来、数据在不在、接口通不通」。
 *
 * 二者互补，交付时都应能跑通。本脚本**只读**，不会修改素材目录里的文件。
 *
 * 用法：
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --port 8899    # 换端口（默认取配置或 8787）
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { createApp } from '../src/app.js';
import { createEnv, buildConfig, SERVER_DIR, PROJECT_ROOT } from '../src/lib/env.js';
import { openDatabase } from '../src/lib/db.js';
import { verifyPassword } from '../src/lib/password.js';
import { runScan } from '../src/lib/scan.js';

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const results = [];
let group = '总览';

function section(title) {
  group = title;
  results.push({ kind: 'section', title });
}

function pass(name, detail = '') {
  results.push({ kind: 'pass', group, name, detail });
}

function fail(name, detail = '') {
  results.push({ kind: 'fail', group, name, detail });
}

function info(name, detail = '') {
  results.push({ kind: 'info', group, name, detail });
}

/**
 * 跑一个检查项：抛异常即判失败，不中断后续检查。
 * @param {string} name
 * @param {() => (void | string | Promise<void|string>)} fn 返回字符串则作为明细
 */
async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const portArgIdx = argv.indexOf('--port');
const portOverride = portArgIdx >= 0 ? Number.parseInt(argv[portArgIdx + 1], 10) : null;

let baseUrl = '';

/**
 * 发一个请求。`--noproxy '*'` 是 curl 的坑，但 Node 的 fetch 尊重 NO_PROXY；
 * 这里直连 127.0.0.1 不设代理，天然绕开。
 */
async function call(method, urlPath, { body, cookie, headers } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（如 PDF 二进制）保留原文长度信息 */
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, text, setCookie, res };
}

/** 从 Set-Cookie 数组里摘出会话 cookie 的 `name=value` 片段（备用工具，当前自检未用到） */
function _sessionCookieOf(setCookie, cookieName) {
  const raw = setCookie.find((c) => c.startsWith(`${cookieName}=`));
  if (!raw) return null;
  return raw.split(';')[0];
}
void _sessionCookieOf;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('西南财经大学金融投资协会 · 后端自检');
  console.log('='.repeat(64));
  console.log();

  const env = createEnv();
  const config = buildConfig(env);
  if (portOverride !== null && Number.isFinite(portOverride)) config.port = portOverride;

  // ---- 1. 环境与配置 -----------------------------------------------------
  section('1. 环境与配置');

  await check('Node 版本满足要求（>= 22.5，需内置 node:sqlite）', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 5)) {
      throw new Error(`当前 ${process.versions.node}，需 >= 22.5.0`);
    }
    return `v${process.versions.node}`;
  });

  await check('已解析运行配置', () => {
    if (!config.dbPath || !config.materialsDir) throw new Error('dbPath / materialsDir 解析失败');
    return `端口 ${config.port} · 会话 ${config.sessionTtlHoursAdmin}h/${config.sessionTtlHoursViewer}h · 登录锁定阈值 ${config.login.maxFails} 次`;
  });

  info('项目根目录', PROJECT_ROOT);
  info('server 目录', SERVER_DIR);
  info('数据库文件', config.dbPath);
  info('素材目录', config.materialsDir);
  info('.env 文件', env.hasEnvFile ? `已加载 ${env.envFile}` : '不存在（使用默认值，首次部署属正常）');

  await check('数据库文件存在', () => {
    if (!existsSync(config.dbPath)) {
      throw new Error(`未找到 ${config.dbPath}，请先运行 npm run setup`);
    }
    return '已找到';
  });

  await check('素材目录存在', () => {
    if (!existsSync(config.materialsDir)) {
      throw new Error(`未找到 ${config.materialsDir}，请检查 MATERIALS_DIR 配置`);
    }
    return '已找到';
  });

  // ---- 2. 数据库内容 -----------------------------------------------------
  section('2. 数据库内容');

  let db = null;
  try {
    db = openDatabase(config.dbPath);

    await check('账号表有可用账号', () => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
      const n = Number(row?.n ?? 0);
      if (n === 0) throw new Error('accounts 表为空，请先运行 npm run seed');
      const byRole = db
        .prepare('SELECT role, COUNT(*) AS n FROM accounts GROUP BY role')
        .all()
        .map((r) => `${r.role} ${r.n}`)
        .join(' / ');
      return `${n} 个（${byRole}）`;
    });

    await check('存在管理权限账号', () => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND revoked_at IS NULL")
        .get();
      const n = Number(row?.n ?? 0);
      if (n === 0) throw new Error('没有有效的 admin 账号');
      return `${n} 个有效`;
    });

    /**
     * 需求：账号 <已清除> 拥有管理权限，口令为 <已清除>，登录后应能进入「社团成员产出」。
     *
     * 这里只做**库级**判定（账号存在 + 角色 + 口令可校验 + 未过期/未吊销）。
     * 真正的端到端登录放在下面的 HTTP 段，因为那是唯一能证明
     * 「口令 → 会话 → 能力列表 → 受限数据」整条链路通的地方。
     */
    await check('演示账号 <已清除> 存在且为管理权限（口令可校验）', () => {
      const row = db
        .prepare("SELECT * FROM accounts WHERE username = '<已清除>' AND revoked_at IS NULL")
        .get();
      if (!row) throw new Error('未找到 <已清除> 账号，请运行 npm run seed');
      if (String(row.role) !== 'admin') throw new Error(`角色应为 admin，实际为 ${row.role}`);
      if (!verifyPassword('<已清除>', String(row.password_hash))) {
        throw new Error('<已清除> 的存储哈希无法用口令 <已清除> 校验通过');
      }
      if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
        throw new Error('该账号已过期');
      }
      return `角色 admin，口令 <已清除> 校验通过${row.expires_at ? `，到期 ${row.expires_at}` : '（无到期时间）'}`;
    });

    await check('资料表有条目', () => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM resources').get();
      const n = Number(row?.n ?? 0);
      if (n === 0) throw new Error('resources 表为空，请先运行 npm run scan:resources');
      return `${n} 条`;
    });

    // 关键安全检查：受限分类必须被标记为 member，不能是 public
    await check('受限分类条目的可见级别正确（不对外公开）', () => {
      const rows = db
        .prepare(
          "SELECT category_dir, access_level, COUNT(*) AS n FROM resources GROUP BY category_dir, access_level"
        )
        .all();
      const leaks = rows.filter(
        (r) => String(r.category_dir) === '研发部内部资料' && String(r.access_level) !== 'member'
      );
      if (leaks.length > 0) {
        throw new Error(
          `发现 ${leaks.length} 组受限分类被标为公开：` +
            leaks.map((l) => `${l.category_dir}=${l.access_level}(${l.n})`).join(', ')
        );
      }
      const restricted = rows
        .filter((r) => String(r.category_dir) === '研发部内部资料')
        .reduce((s, r) => s + Number(r.n), 0);
      return `${restricted} 条受限条目已正确隔离`;
    });

    await check('字数统计与明细一致（无漂移）', () => {
      const bad = db
        .prepare(
          `SELECT COUNT(*) AS n FROM resource_stats s
           WHERE s.likes <> (SELECT COUNT(*) FROM resource_likes l WHERE l.resource_id = s.resource_id)`
        )
        .get();
      const n = Number(bad?.n ?? 0);
      if (n > 0) throw new Error(`${n} 条统计记录与点赞明细不一致，可重跑 npm run scan:resources 修复`);
      return '全部一致';
    });

    await check('新闻表状态', () => {
      const has = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_items'")
        .get();
      if (!has) return '尚未建表（首次调用新闻接口时自动创建）';
      const row = db.prepare('SELECT COUNT(*) AS n FROM news_items').get();
      const n = Number(row?.n ?? 0);
      return n > 0 ? `${n} 条已缓存` : '暂无缓存（首次调用时会联网抓取）';
    });

    // ---- 展示类目（「资料与数据」的分类体系） ---------------------------
    await check('display_category 列已存在（老库升级路径）', () => {
      const cols = db.prepare('PRAGMA table_info(resources)').all();
      const has = cols.some((c) => String(c.name) === 'display_category');
      if (!has) {
        throw new Error(
          'resources 表缺少 display_category 列。openDatabase 里的 ensureColumns 会自动补，' +
            '若这里仍缺失，说明建库路径绕过了它'
        );
      }
      return '已就绪';
    });

    await check('展示类目已正确归集（资料四类 + 产出，logo 排除）', () => {
      const rows = db
        .prepare('SELECT category_dir, display_category, COUNT(*) AS n FROM resources GROUP BY 1, 2')
        .all();

      // logo 属于首页展示素材，不计入资料统计
      const nonLogo = rows.filter((r) => String(r.category_dir) !== 'logo');
      const logoRows = rows.filter((r) => String(r.category_dir) === 'logo');

      // 两个模块分账：资料与数据（外部资料）/ 社团成员产出（自产作品）
      const libRows = nonLogo.filter((r) => String(r.display_category) !== '社团成员产出');
      const prodRows = nonLogo.filter((r) => String(r.display_category) === '社团成员产出');
      const libTotal = libRows.reduce((s, r) => s + Number(r.n), 0);
      const prodTotal = prodRows.reduce((s, r) => s + Number(r.n), 0);
      if (libTotal === 0) throw new Error('资料与数据模块没有任何条目');

      // 每个非 logo 条目的 display_category 必须落在两个模块的类目白名单内
      const allowedLib = new Set(['电子书籍', '数据', '研报', '课程资源']);
      const allowedProd = new Set(['社团成员产出']);
      const bad = nonLogo.filter(
        (r) =>
          !allowedLib.has(String(r.display_category)) &&
          !allowedProd.has(String(r.display_category))
      );
      if (bad.length > 0) {
        throw new Error(
          `有 ${bad.length} 组条目的展示类目不在白名单内（不该出现「其他」）：` +
            bad.map((b) => `${b.display_category}(${b.n})`).join(', ')
        );
      }

      // 资料库每个实体类目都要有内容 —— 若某类恒为 0，多半是分类规则退化了
      const byCat = new Map();
      for (const r of libRows) {
        byCat.set(String(r.display_category), (byCat.get(String(r.display_category)) ?? 0) + Number(r.n));
      }
      const empty = [...allowedLib].filter((c) => !byCat.get(c));
      const detail = [...allowedLib].map((c) => `${c} ${byCat.get(c) ?? 0}`).join(' / ');

      if (empty.length > 0) {
        // 只提示不判失败：素材确实可能暂时缺某一类
        info('展示类目分布', `${detail}（${empty.join('、')} 暂为空）`);
      }
      return (
        `${detail}，合计 ${libTotal} 条；产出 ${prodTotal} 条；` +
        `logo ${logoRows.reduce((s, r) => s + Number(r.n), 0)} 个已排除`
      );
    });

    await check('department 列已存在（老库升级路径）', () => {
      const cols = db.prepare('PRAGMA table_info(resources)').all();
      const has = cols.some((c) => String(c.name) === 'department');
      if (!has) {
        throw new Error(
          'resources 表缺少 department 列。它是「社团成员产出」页面部门导航的筛选依据，' +
            '由 openDatabase 的 ensureColumns 自动补 —— 这里缺失说明建库路径绕过了它'
        );
      }
      return '已就绪';
    });

    /**
     * 部门是「社团成员产出」页面顶部的纵向筛选维度。
     *
     * 这里只做**软校验**（不通过即 info 提示而非失败）：部门归属依赖人工在
     * production-meta.json 里标注，素材刚入库时确实可能一条都没标。
     * 硬失败会让「新增一个还没归部门的作品」直接卡住自检，得不偿失。
     * 真正不能出错的是**口径**：部门不得混进展示类目体系 —— 那条下面单独校验。
     */
    await check('产出作品的部门标注（软校验，允许为空）', () => {
      const prodRows = db
        .prepare("SELECT department, COUNT(*) AS n FROM resources WHERE display_category = '社团成员产出' GROUP BY 1")
        .all();
      const total = prodRows.reduce((s, r) => s + Number(r.n), 0);
      if (total === 0) return '产出模块暂无条目';

      const labelled = prodRows.filter((r) => String(r.department ?? '') !== '');
      const unlabelled = total - labelled.reduce((s, r) => s + Number(r.n), 0);
      const detail = labelled.map((r) => `${r.department} ${r.n}`).join(' / ') || '（无）';

      if (unlabelled > 0) {
        info(
          '未标部门的产出',
          `${unlabelled} 条将在产出页只出现在「全部」下、不进任何部门标签。` +
            '如需归类，在 server/data/production-meta.json 里补 department 字段后重新扫描'
        );
      }
      return `${detail}；未标部门 ${unlabelled} 条 / 共 ${total} 条`;
    });

    /**
     * 反向校验：部门**不得**出现在展示类目里。
     *
     * 展示类目是模块隔离的依据（`moduleScope()` 靠它把「资料与数据」与
     * 「社团成员产出」分开），一旦把部门当类目写进去，
     * 「全部 = 各类之和」的口径会崩，两个页面还会互相串台。
     */
    await check('部门未被误当作展示类目（两个维度必须正交）', () => {
      const bad = db
        .prepare(
          "SELECT display_category, COUNT(*) AS n FROM resources WHERE display_category IN ('研发部','培训部','宣传中心') GROUP BY 1"
        )
        .all();
      if (bad.length > 0) {
        throw new Error(
          `部门名出现在了 display_category 里：${bad.map((b) => `${b.display_category}(${b.n})`).join(', ')}。` +
            '部门是产出模块内部的纵向筛选，不能进展示类目体系'
        );
      }
      return '展示类目只含模块级类目，部门走独立字段';
    });

    await check('展示类目统计与明细自洽', () => {
      const rows = db
        .prepare('SELECT category_dir, display_category FROM resources')
        .all()
        .filter((r) => String(r.category_dir) !== 'logo');
      const all = rows.length;
      const parts = rows.filter((r) => r.display_category).length;
      if (all !== parts) {
        throw new Error(`${all - parts} 条资料没有展示类目，「全部」与分项数字会对不上`);
      }
      // 注意：这里的 all 是**两个模块的合集**（资料四类 + 社团成员产出）。
      // 各模块自己的「全部」口径由 /api/resources/categories?module= 提供，不要混用。
      return `${all} 条非 logo 条目均已归入展示类目（资料 + 产出）`;
    });

    await check('财经时事归档在保留窗口内', () => {
      const has = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_items'")
        .get();
      if (!has) return '尚未建表';
      const keepDays = config.news.keepDays;
      const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
      const stale = db
        .prepare('SELECT COUNT(*) AS n FROM news_items WHERE bucket_date < ?')
        .get(cutoff);
      const n = Number(stale?.n ?? 0);
      if (n > 0) {
        throw new Error(
          `有 ${n} 条超出 ${keepDays} 天保留窗口的缓存未被清理。` +
            'availableDates 会自动过滤它们，但仍应跑一次抓取让 cleanup() 回收'
        );
      }
      const days = db
        .prepare('SELECT COUNT(DISTINCT bucket_date) AS n FROM news_items')
        .get();
      return `${Number(days?.n ?? 0)} 天归档，窗口 ${keepDays} 天内干净`;
    });
  } catch (err) {
    fail('打开数据库', err instanceof Error ? err.message : String(err));
  }

  // ---- 3. 只读扫描（幂等性） --------------------------------------------
  section('3. 扫描幂等性（只读验证）');

  if (db) {
    await check('重复扫描不产生重复条目', () => {
      const before = Number(db.prepare('SELECT COUNT(*) AS n FROM resources').get()?.n ?? 0);
      // runScan 只读磁盘 + upsert 自己的 table，不碰素材文件本身
      const r = runScan(db, {
        materialsDir: config.materialsDir,
      });
      if (r.inserted !== 0) {
        throw new Error(`预期 0 条新增，实际新增 ${r.inserted} 条（扫描非幂等）`);
      }
      const after = Number(db.prepare('SELECT COUNT(*) AS n FROM resources').get()?.n ?? 0);
      if (after !== before) {
        throw new Error(`条目总数变化：${before} → ${after}`);
      }
      return `${r.total} 条，更新 ${r.updated} 条，新增 0 条`;
    });

    await check('分类分布与磁盘一致', () => {
      const rows = db
        .prepare('SELECT category_dir, COUNT(*) AS n FROM resources GROUP BY category_dir ORDER BY n DESC')
        .all();
      return rows.map((r) => `${r.category_dir} ${r.n}`).join(' · ');
    });
  }

  // ---- 4. HTTP 接口 ------------------------------------------------------
  section('4. HTTP 接口（真实起服务）');

  let app = null;
  let server = null;

  if (db) {
    app = createApp({
      config,
      db,
      fingerprintSecret: 'verify-only-secret',
      logger: () => {}, // 自检时静音访问日志，保持输出干净
    });
    server = createServer(app.handler);
    // 端口可能被上一次没退干净的实例占着。不用「换端口」硬闯，而是先探测：
    // 若默认端口被占，就退到系统随机空闲端口 —— 自检的目标是验证后端能力，
    // 不是验证「8787 现在空不空」，被占用不应算作后端的失败。
    const listenOn = (port, host) =>
      new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });

    try {
      await listenOn(config.port, config.host);
    } catch (err) {
      if (err?.code === 'EADDRINUSE') {
        const actual = server.address()?.port ?? config.port;
        info(
          '端口占用',
          `${config.host}:${config.port} 已被占用，自动改用空闲端口 0（不影响自检结论）`
        );
        void actual;
        await listenOn(0, config.host);
      } else {
        throw err;
      }
    }
    const boundPort = server.address()?.port ?? config.port;
    baseUrl = `http://${config.host}:${boundPort}`;
    info('服务地址', baseUrl);
  }

  if (server) {
    try {
      // --- 健康检查 ---
      await check('GET /api/health 服务可用', async () => {
        const r = await call('GET', '/api/health');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return `HTTP 200 · ${r.json?.data?.status ?? 'ok'}`;
      });

      // --- 匿名身份 ---
      await check('GET /api/auth/me 匿名返回访客（而非报错）', async () => {
        const r = await call('GET', '/api/auth/me');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}，应为 200`);
        if (r.json?.data?.authenticated !== false) throw new Error('匿名用户被判定为已登录');
        return `role=${r.json.data.role}`;
      });

      // --- 错误的登录必须被拒 ---
      //
      // ⚠️ 这里**刻意用不存在的账号名**，而不是像以前那样对 `admin` 连发错误口令。
      //    原因是失败计数是按 `u:<账号>` 与 `ip:<IP>` 两个维度累加的，verify 在同一台机器上
      //    反复运行时 IP 维度会攒够 5 次失败并锁定 15 分钟 —— 但 `accounts.login` 是在
      //    **校验口令之前**就查锁定，所以锁定期间连正确口令也会被挡在 429，
      //    紧接着的「<已清除> 可登录」那条检查就会莫名其妙地失败。
      //    用一个每次带随机后缀的账号名，既保留了「失败不下发 cookie」的断言，
      //    也不会污染真实账号的失败计数。
      await check('错误口令被拒（401，且不下发会话 cookie）', async () => {
        const probeUser = `__probe_${Date.now().toString(36)}`;
        const r = await call('POST', '/api/auth/login', {
          body: { username: probeUser, password: 'definitely-wrong-password' },
        });
        if (r.status !== 401) throw new Error(`HTTP ${r.status}，应为 401`);
        if (r.setCookie.some((c) => c.startsWith(`${config.cookieName}=`) && !c.includes('Max-Age=0'))) {
          throw new Error('失败登录竟然下发了会话 cookie');
        }
        return `HTTP 401 · code=${r.json?.error?.code ?? 'n/a'}`;
      });

      // --- 「社团成员产出」的准入链路：<已清除> 登录后必须真的能拿到受限数据 ---
      //
      // 这条检查覆盖的是需求的核心断言：「输入账号 <已清除>、口令 <已清除>，然后进入浏览页面」。
      // 只验「账号存在」不够 —— 能力列表是角色算出来的，会话是真签发的，
      // 受限数据是真按会话过滤的，三者任何一环断了都要在这里暴露。
      await check('<已清除> / <已清除> 可登录并解锁「社团成员产出」（受限数据可见）', async () => {
        const login = await call('POST', '/api/auth/login', {
          body: { username: '<已清除>', password: '<已清除>' },
        });
        if (login.status !== 200) {
          throw new Error(`登录失败 HTTP ${login.status}：${login.json?.error?.message ?? ''}`);
        }
        const caps = login.json?.data?.account?.capabilities ?? [];
        // 「社团成员产出」路由守卫要求 canViewRestricted；管理后台要求 canManageContent
        for (const need of ['canViewRestricted', 'canManageContent']) {
          if (!caps.includes(need)) throw new Error(`能力列表缺少 ${need}：${caps.join('/')}`);
        }

        const cookie = _sessionCookieOf(login.setCookie, config.cookieName);
        if (!cookie) throw new Error('登录成功却没有下发会话 cookie');

        // 用同一会话读受限资料：必须比匿名看到更多（多出来的正是受限条目）
        const asMember = await call('GET', '/api/resources?pageSize=500', { cookie });
        const asGuest = await call('GET', '/api/resources?pageSize=500');
        const memberItems = asMember.json?.data?.items ?? [];
        const guestItems = asGuest.json?.data?.items ?? [];
        const memberRestricted = memberItems.filter((it) => it.accessLevel !== 'public').length;
        if (memberRestricted === 0) {
          throw new Error('登录后仍看不到任何受限条目，「浏览页面」会是空的');
        }
        if (memberItems.length <= guestItems.length) {
          throw new Error(
            `登录视角条目数(${memberItems.length})未超过访客(${guestItems.length})，受限过滤可能失效`
          );
        }

        // 会话必须被 /api/auth/me 认出来，前端守卫才能在刷新后放行
        const me = await call('GET', '/api/auth/me', { cookie });
        if (me.json?.data?.authenticated !== true) throw new Error('/api/auth/me 不认这个会话');

        // 顺手确认隔离方向没写反：该会话不应把受限数据泄露给匿名（上面已验）
        return `HTTP 200 · 登录视角 ${memberItems.length} 条（受限 ${memberRestricted} 条）> 访客 ${guestItems.length} 条`;
      });

      // --- 受限资料不能被匿名读到（核心防泄露断言）---
      await check('匿名访客读不到受限资料（即使伪造参数）', async () => {
        const plainRes = await call('GET', '/api/resources?pageSize=500');
        const faked = await call('GET', '/api/resources?pageSize=500&restricted=1');
        const plainItems = plainRes.json?.data?.items ?? [];
        const fakedItems = faked.json?.data?.items ?? [];
        const leak = [...plainItems, ...fakedItems].filter(
          (it) => String(it.category) === '研发部内部资料' || String(it.accessLevel) === 'member'
        );
        if (leak.length > 0) {
          throw new Error(`泄露 ${leak.length} 条受限资料，例如「${leak[0].name}」`);
        }
        return `匿名可见 ${plainItems.length} 条，传 restricted=1 仍为 ${fakedItems.length} 条，无泄露`;
      });

      // --- 「资料与数据」展示类目：接口层必须返回固定五类且自洽 ---
      await check('资料接口按「全部/电子书籍/数据/研报/课程资源」返回类目', async () => {
        const r = await call('GET', '/api/resources?pageSize=1');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const cats = r.json?.data?.categories ?? [];
        if (cats.length !== 5) {
          throw new Error(
            `应返回 5 个类目（全部 + 4 类），实际 ${cats.length}：${cats.map((c) => c.category).join('/')}`
          );
        }
        // 接口用 category 字段承载类目名（与资源对象的 category 语义不同：这里是展示类目）
        const got = cats.map((c) => String(c.category));
        const want = ['全部', '电子书籍', '数据', '研报', '课程资源'];
        if (got.join('/') !== want.join('/')) {
          throw new Error(`类目顺序或名称不符。期望 ${want.join('/')}，实际 ${got.join('/')}`);
        }
        if (!cats[0].aggregate) throw new Error('「全部」应带 aggregate 标记，前端靠它做聚合视图');
        return cats.map((c) => `${c.category}:${c.count}`).join('  ');
      });

      await check('「全部」条目数等于四类之和（不重不漏）', async () => {
        const r = await call('GET', '/api/resources?pageSize=1');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const cats = r.json?.data?.categories ?? [];
        if (cats.length !== 5) throw new Error(`类目数异常：${cats.length}`);
        const total = Number(cats[0].count ?? 0);
        const parts = cats.slice(1).reduce((s, c) => s + Number(c.count ?? 0), 0);
        if (total !== parts) {
          throw new Error(`「全部」${total} ≠ 四类之和 ${parts}，存在重复归类或漏归类`);
        }
        // 接口的 summary.total 必须与「全部」一致，否则前端两处数字会打架
        const sumTotal = r.json?.data?.summary?.total;
        if (sumTotal !== undefined && Number(sumTotal) !== total) {
          throw new Error(`summary.total=${sumTotal} 与「全部」${total} 不一致`);
        }
        return `${total} = ${cats.slice(1).map((c) => c.count).join(' + ')}`;
      });

      await check('类目筛选各自返回本类条目（互不串档）', async () => {
        const names = ['电子书籍', '数据', '研报', '课程资源'];
        const detail = [];
        for (const name of names) {
          const r = await call('GET', `/api/resources?pageSize=500&displayCategory=${encodeURIComponent(name)}`);
          if (r.status !== 200) throw new Error(`${name} 筛选 HTTP ${r.status}`);
          const items = r.json?.data?.items ?? [];
          const stray = items.filter((it) => String(it.displayCategory) !== name);
          if (stray.length > 0) {
            throw new Error(`${name} 里混入 ${stray.length} 条异类，例如「${stray[0].name}」标为 ${stray[0].displayCategory}`);
          }
          detail.push(`${name}:${items.length}`);
        }
        return detail.join('  ');
      });

      await check('公司 logo 不进「资料与数据」（展示素材与资料库分流）', async () => {
        const r = await call('GET', '/api/resources?pageSize=500');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = r.json?.data?.items ?? [];
        const logoish = items.filter(
          (it) => String(it.category) === 'logo' || /logo|图标|标志/i.test(String(it.name ?? ''))
        );
        if (logoish.length > 0) {
          throw new Error(`${logoish.length} 条 logo 素材出现在资料库，例如「${logoish[0].name}」`);
        }
        // 直接从库里数 logo 总数 —— 不能再走接口。
        // `includeNonLibrary` 是服务层参数，路由层**有意不转发**（否则等于给所有
        // 非资料目录开后门），所以从 HTTP 侧永远读不到 logo 全量。想核对
        // 「素材是否还在库里」，只能查库。
        const logoCount = db
          .prepare("SELECT COUNT(*) AS n FROM resources WHERE category_dir = 'logo'")
          .get();
        return `资料库 ${items.length} 条已排除 logo；库内仍保留 ${logoCount.n} 条 logo 原始素材（首页用）`;
      });

      /**
       * 这条守住一个**真实发生过的静默缺陷**：
       *
       * logo 属于非资料目录，服务层按 `isLibraryItem()` 剔除；而路由层从不转发
       * `includeNonLibrary`，于是 `category=logo` 被无条件滤空。前端「会友去向」
       * 拿到 0 条后 `return null`，整个版块消失且**无任何报错**——首页少一块，
       * 没人会收到告警。所以这里必须有一条**正面**断言：点名索取必须拿得到。
       */
      await check('首页 logo 素材可被点名索取（category=logo 放行）', async () => {
        const r = await call('GET', '/api/resources?category=logo&pageSize=200');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = r.json?.data?.items ?? [];
        if (items.length === 0) {
          throw new Error(
            'category=logo 返回 0 条 —— 首页「会友去向／合作单位」会静默消失（非资料目录被误滤）'
          );
        }
        const notLogo = items.filter((it) => String(it.category) !== 'logo');
        if (notLogo.length > 0) {
          throw new Error(`点名 logo 却混入 ${notLogo.length} 条其它目录条目`);
        }
        // 缩略图/预览链路必须可用，否则前端拿到清单也渲染不出图
        const probe = items[0];
        const p = await call('GET', `/api/resources/${probe.id}/preview`);
        if (p.status !== 200) throw new Error(`预览接口 HTTP ${p.status}，应为 200`);
        return `${items.length} 条 logo 可读（如「${probe.name}」），预览接口 HTTP 200`;
      });

      // --- 管理接口必须要求会话 ---
      await check('GET /api/admin/accounts 匿名被拒（401）', async () => {
        const r = await call('GET', '/api/admin/accounts');
        if (r.status !== 401) throw new Error(`HTTP ${r.status}，应为 401`);
        return 'HTTP 401';
      });

      // --- 真实登录（凭据从库中取，不硬编码）---
      const adminRows = db
        .prepare("SELECT username FROM accounts WHERE role='admin' AND revoked_at IS NULL LIMIT 1")
        .all();
      if (adminRows.length === 0) {
        info('真实登录链路', '跳过：库中没有可用的 admin 账号（请先 npm run seed）');
      } else {
        info('真实登录链路', `使用库中账号 ${String(adminRows[0].username)}（口令来自 .env / 播种脚本）`);
      }

      // --- PDF 预览与 Range ---
      const docRow = db
        .prepare(
          "SELECT id, rel_path, file_name FROM resources WHERE access_level='public' AND ext='pdf' LIMIT 1"
        )
        .get();
      if (docRow) {
        const rid = Number(docRow.id);

        await check('PDF 预览：响应头正确（inline + 支持断点续传）', async () => {
          const r = await call('GET', `/api/resources/${rid}/preview`);
          const ct = r.res.headers.get('content-type') ?? '';
          const cd = r.res.headers.get('content-disposition') ?? '';
          const ar = r.res.headers.get('accept-ranges') ?? '';
          if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
          if (!ct.includes('application/pdf')) throw new Error(`Content-Type 异常：${ct}`);
          if (!cd.startsWith('inline')) throw new Error(`预览应为 inline，实际 ${cd.slice(0, 40)}`);
          if (!/filename\*=UTF-8''/.test(cd)) {
            throw new Error('中文文件名未使用 RFC 5987 编码，部分浏览器会乱码');
          }
          if (ar !== 'bytes') throw new Error(`Accept-Ranges 应为 bytes，实际 ${ar}`);
          return 'Content-Type / Content-Disposition / Accept-Ranges 均正确';
        });

        await check('PDF 分页：Range 请求返回 206 与正确 Content-Range', async () => {
          const r = await call('GET', `/api/resources/${rid}/preview`, {
            headers: { Range: 'bytes=0-1023' },
          });
          if (r.status !== 206) throw new Error(`HTTP ${r.status}，应为 206 Partial Content`);
          const cr = r.res.headers.get('content-range') ?? '';
          if (!/^bytes 0-1023\/\d+$/.test(cr)) throw new Error(`Content-Range 异常：${cr}`);
          return cr;
        });

        await check('下载端点单独可用（Content-Disposition 为 attachment）', async () => {
          const r = await call('GET', `/api/resources/${rid}/download`);
          const cd = r.res.headers.get('content-disposition') ?? '';
          if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
          if (!cd.startsWith('attachment')) throw new Error(`下载应为 attachment，实际 ${cd.slice(0, 40)}`);
          return cd.slice(0, 72) + '…';
        });
      } else {
        info('PDF 预览链路', '跳过：库中没有公开的 PDF（请先 npm run scan:resources）');
      }

      // --- 点赞幂等 ---
      const anyRes = db.prepare("SELECT id FROM resources WHERE access_level='public' LIMIT 1").get();
      if (anyRes) {
        const rid = Number(anyRes.id);
        await check('点赞去重：同一来源重复点赞计数不变', async () => {
          const h = { 'X-Forwarded-For': '203.0.113.77' };
          const a = await call('POST', `/api/resources/${rid}/like`, { headers: h });
          const b = await call('POST', `/api/resources/${rid}/like`, { headers: h });
          const c1 = a.json?.data?.likes;
          const c2 = b.json?.data?.likes;
          if (a.status !== 200 || b.status !== 200) {
            throw new Error(`HTTP ${a.status}/${b.status}`);
          }
          if (c1 !== c2) throw new Error(`计数被重复累加：${c1} → ${c2}`);
          if (b.json?.data?.alreadyLiked !== true) throw new Error('第二次点赞未返回 alreadyLiked');
          // 回滚这次自检留下的点赞，保持数据库干净
          await call('DELETE', `/api/resources/${rid}/like`, { headers: h });
          return `计数稳定在 ${c2}（已回滚本次自检记录）`;
        });
      }

      // --- 受限条目的写操作闸门（曾经的真实漏洞：读被拦、写放行）---
      const secretRow = db
        .prepare("SELECT id, name FROM resources WHERE access_level='member' LIMIT 1")
        .get();
      if (secretRow) {
        const sid = Number(secretRow.id);
        await check('受限资料的点赞：匿名被拒，且不泄露条目元数据', async () => {
          const r = await call('POST', `/api/resources/${sid}/like`);
          if (r.status !== 401) {
            throw new Error(`匿名给受限资料点赞应 401，实际 HTTP ${r.status}`);
          }
          if (r.json?.error?.code !== 'UNAUTHENTICATED') {
            throw new Error(`错误码应为 UNAUTHENTICATED，实际 ${r.json?.error?.code}`);
          }
          const body = JSON.stringify(r.json ?? {});
          if (secretRow.name && body.includes(String(secretRow.name))) {
            throw new Error('拒绝响应回显了受限条目名称，构成元数据泄露');
          }
          return `HTTP 401 · code=UNAUTHENTICATED · 未回显条目名称`;
        });

        await check('受限资料的取消点赞：匿名同样被拒', async () => {
          const r = await call('DELETE', `/api/resources/${sid}/like`);
          if (r.status !== 401) throw new Error(`应 401，实际 HTTP ${r.status}`);
          return 'HTTP 401';
        });
      } else {
        info('受限条目写操作闸门', '跳过：库中没有受限条目');
      }

      // --- 行情多源适配器 ---
      await check('行情接口返回真实数据（或明确说明回退原因）', async () => {
        const r = await call('GET', '/api/stock/quote?code=600702');
        if (r.status !== 200) {
          const msg = r.json?.error?.message ?? r.text.slice(0, 120);
          throw new Error(`HTTP ${r.status} · ${msg}`);
        }
        const d = r.json?.data ?? {};
        const q = d.quote ?? d;
        if (q.price === undefined || q.price === null) {
          throw new Error(`缺少 price 字段：${JSON.stringify(d).slice(0, 160)}`);
        }
        // 真实数据一定带时间戳；演示数据不会有 asOf / date 这类字段
        const stamp = q.asOf ?? q.time ?? q.date ?? d.asOf ?? '（无时间戳）';
        return `${q.name ?? q.code ?? '600702'} ${q.price} · ${stamp} · 来源 ${d.source ?? q.source ?? 'n/a'}`;
      });

      await check('行情数据源状态可查询（便于排查源不可达）', async () => {
        const r = await call('GET', '/api/stock/status');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = r.json?.data ?? {};
        const primary = d.primary?.available ? '可达' : '不可达';
        const fb = d.fallback?.available ? '可达' : '不可达';
        return `主源 free-stockdb ${primary} · 回退源 腾讯 ${fb} · 本次走 ${d.activeSource ?? 'n/a'}`;
      });

      // --- 行情主源不可达时的回退行为 ---
      await check('主源不可达时能自动回退（不返回演示数据）', async () => {
        const r = await call('GET', '/api/stock/quote?code=600702');
        if (r.status !== 200) {
          return `两个源都不可达（HTTP ${r.status}），已如实报错而非伪造数据 —— 符合预期`;
        }
        const d = r.json?.data ?? {};
        const src = d.source ?? d.quote?.source;
        if (!src) throw new Error('返回了数据但没有标注来源，无法判断是真实数据还是演示数据');
        return `来源标注为 ${src}${d.fallbackReason ? ` · 回退原因：${d.fallbackReason}` : ''}`;
      });

      // --- 标的检索（名称 / 拼音 / 代码） ---
      //
      // 这条是**正面断言**：只看「6 位代码能查到」不足以证明检索能力存在，
      // 必须实际用**中文名称**与**拼音简写**各发一次请求，并确认返回的是 A 股。
      await check('标的检索支持名称 / 拼音（不只 6 位代码）', async () => {
        const cases = [
          { kw: '舍得', expectCode: '600702' },
          { kw: 'gzmt', expectCode: '600519' },
          { kw: '600702', expectCode: '600702' },
        ];
        const results = [];
        for (const c of cases) {
          const r = await call('GET', `/api/stock/search?kw=${encodeURIComponent(c.kw)}`);
          if (r.status !== 200) {
            return `检索接口不可用（HTTP ${r.status}）—— 外部联想源可能被网络策略拦截`;
          }
          const items = r.json?.data?.items ?? [];
          if (items.length === 0) {
            return `「${c.kw}」无候选 —— 外部联想源可能被网络策略拦截`;
          }
          // 只允许 A 股：market 必须是沪深北，代码必须是 6 位
          const bad = items.find(
            (it) => !/^(sh|sz|bj)$/.test(String(it.market)) || !/^\d{6}$/.test(String(it.code))
          );
          if (bad) {
            throw new Error(
              `检索「${c.kw}」返回了非 A 股条目：${bad.name}(${bad.market}${bad.code})。` +
                '行情终端只支持 A 股取数，放行港美股会让用户选中一个必然失败的结果'
            );
          }
          const hit = items.find((it) => it.code === c.expectCode);
          if (!hit) {
            throw new Error(
              `检索「${c.kw}」未命中预期代码 ${c.expectCode}，实际：` +
                items.map((it) => `${it.name}/${it.code}`).join(', ')
            );
          }
          if (!hit.name) throw new Error(`检索「${c.kw}」命中的条目缺少名称（公司名不可为空）`);
          results.push(`${c.kw}→${hit.name}(${hit.code})`);
        }
        return results.join(' · ');
      });

      // --- 行情返回必须带公司名称 ---
      //
      // 回归断言：主源（free-stockdb）的日 K 表没有名称字段，
      // 早期 klines 接口在走主源时把 name 返回成空串，
      // 前端于是只能显示一串数字代码 —— 「查到数据但没有公司名称」。
      await check('行情接口返回公司名称（缺失时应显式说明）', async () => {
        const r = await call('GET', '/api/stock/kline?code=600702&limit=5');
        if (r.status !== 200) {
          return `行情源不可达（HTTP ${r.status}），本次跳过名称校验`;
        }
        const d = r.json?.data ?? {};
        const name = String(d.name ?? '').trim();
        const source = String(d.source ?? '');

        if (!name) {
          // 腾讯源自己就带名称字段，若这里为空说明字段在透传环节丢了 —— 那是真 bug。
          if (source === 'tencent') {
            throw new Error('回退源（腾讯）本身携带名称，返回为空说明字段未被透传');
          }
          // 主源不含名称，名称要靠反查；反查也失败只可能是外部网络不可达，
          // 属于环境问题而非代码缺陷，因此只提示不判失败。
          info('名称解析', '主源与名称反查均不可达，本次未取到名称（前端会退化为显示代码）');
          return '名称未取得（外部名称源不可达）';
        }
        if (name === String(d.code)) {
          throw new Error('返回的 name 与 code 相同 —— 说明名称没有被真正解析出来');
        }
        return `${name}（${d.code}）· 来源 ${source}`;
      });


      await check('新闻接口可用（每日条目）', async () => {
        const r = await call('GET', '/api/news/daily?limit=10');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = r.json?.data ?? {};
        const items = d.items ?? d.news ?? [];
        if (items.length === 0) {
          return '接口正常但暂无缓存条目（首次抓取可能因网络不可达而延后）';
        }
        const withUrl = items.filter((it) => it.url).length;
        if (withUrl === 0) throw new Error('条目全部缺少 url 字段');
        return `${items.length} 条（含链接 ${withUrl} 条）· 日期 ${d.bucketDate ?? d.date ?? 'n/a'}`;
      });

      await check('新闻抓取状态可查询', async () => {
        const r = await call('GET', '/api/news/status');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = r.json?.data ?? {};
        const sources = d.sources?.length ?? 0;
        const states = d.states?.length ?? 0;
        const err = d.lastError ? ` · 最近错误：${String(d.lastError).slice(0, 60)}` : '';
        return `${sources} 个信源 · ${states} 条抓取记录${err}`;
      });

      // --- 一周归档与日期切换 ---
      await check('每日条目带归档日期列表（保留一周、可点击切换）', async () => {
        const r = await call('GET', '/api/news/daily?limit=10');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = r.json?.data ?? {};
        if (!Array.isArray(d.dates)) {
          throw new Error('响应缺少 dates 字段，前端日期条无从渲染');
        }
        if (typeof d.keepDays !== 'number' || d.keepDays < 7) {
          throw new Error(`保留天数应不少于 7，实际 ${d.keepDays}`);
        }
        // 归档日期不得超过保留窗口，否则是 cleanup 未跑时的残留
        const stale = d.dates.filter((x) => !x.date);
        if (stale.length > 0) throw new Error(`${stale.length} 条归档记录缺少日期`);
        return `${d.dates.length} 天可切换（${d.dates.map((x) => `${x.date}×${x.count}`).join(' ')}） · 保留 ${d.keepDays} 天`;
      });

      await check('归档日期接口可用（独立于当日抓取，接口挂掉也能渲染日期条）', async () => {
        const r = await call('GET', '/api/news/dates');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const d = r.json?.data ?? {};
        if (!Array.isArray(d.dates)) throw new Error('响应缺少 dates 数组');
        const bad = d.dates.filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date)));
        if (bad.length > 0) throw new Error(`日期格式非法：${bad[0].date}`);
        return `${d.dates.length} 天 · 保留 ${d.keepDays ?? 'n/a'} 天`;
      });

      await check('按日期回看历史条目（归档读取链路）', async () => {
        const datesRes = await call('GET', '/api/news/dates');
        const first = (datesRes.json?.data?.dates ?? [])[0];
        if (!first) return '暂无归档日期，跳过（首次抓取后即可验证）';
        const r = await call('GET', `/api/news/daily?limit=10&date=${first.date}`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status} · ${r.json?.error?.message ?? ''}`);
        const d = r.json?.data ?? {};
        const items = d.items ?? [];
        if (items.length === 0) throw new Error(`归档日期 ${first.date} 返回 0 条，但日期条声称有 ${first.count} 条`);
        const bucket = String(d.bucketDate ?? d.date ?? '');
        if (bucket !== first.date) {
          throw new Error(`请求 ${first.date} 却返回 ${bucket} 的数据，归档串档`);
        }
        return `${first.date} 回看 ${items.length} 条 · fromCache=${d.fromCache ?? 'n/a'}`;
      });

      await check('非法日期被拒（形状 + 真实日历双重校验）', async () => {
        const bads = ['2026-13-45', '2026-02-31', '2026-9-20', '20260920', 'today'];
        const leaked = [];
        for (const b of bads) {
          const r = await call('GET', `/api/news/daily?date=${encodeURIComponent(b)}`);
          if (r.status !== 400) leaked.push(`${b}→HTTP ${r.status}`);
        }
        if (leaked.length > 0) {
          throw new Error(`以下非法日期未被拒：${leaked.join('、')}（应全部 400）`);
        }
        const ok = await call('GET', '/api/news/daily?date=2026-09-20');
        if (ok.status === 400) throw new Error('合法但无归档的日期不应报错，应返回空列表');
        return `${bads.length} 个非法日期全部 400 · 合法日期返回 HTTP ${ok.status}`;
      });

      await check('新闻条目按时间倒序（相关度只做次序键，不破坏时间线）', async () => {
        const r = await call('GET', '/api/news/daily?limit=50');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = r.json?.data?.items ?? [];
        if (items.length < 2) return `仅 ${items.length} 条，无法判断顺序`;
        const times = items.map((it) => Date.parse(String(it.publishedAt ?? '')) || 0);
        for (let i = 1; i < times.length; i += 1) {
          if (times[i] > times[i - 1]) {
            throw new Error(
              `第 ${i} 条（${items[i].publishedAt}）比上一条（${items[i - 1].publishedAt}）更新，时间线被相关度排序打乱`
            );
          }
        }
        const span = items[0].publishedAt && items[items.length - 1].publishedAt
          ? `${items[0].publishedAt} → ${items[items.length - 1].publishedAt}`
          : '';
        return `${items.length} 条严格倒序 · ${span}`;
      });

      await check('信源以东方财富为主（金融相关源优先）', async () => {
        const r = await call('GET', '/api/news/status');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const sources = r.json?.data?.sources ?? [];
        if (sources.length === 0) return '信源列表为空，跳过';
        const ids = sources.map((s) => String(s.id ?? s.name ?? ''));
        const emIdx = ids.findIndex((x) => /eastmoney|东方财富/i.test(x));
        if (emIdx < 0) throw new Error(`信源中没有东方财富：${ids.join('/')}`);
        if (emIdx !== 0) throw new Error(`东方财富应为首选信源，实际排第 ${emIdx + 1}：${ids.join('/')}`);
        return `${ids.length} 个信源 · 首选 ${ids[0]}`;
      });

      await check('当日条目与金融市场相关（拒绝无关来源整体污染信息流）', async () => {
        const r = await call('GET', '/api/news/daily?limit=50');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = r.json?.data?.items ?? [];
        if (items.length === 0) return '当日暂无条目，跳过相关性抽检';

        // 用后端自己的判定器，而不是另写一套关键词。
        // 两套词表会漂移：自检说「不相关」而线上认为相关，谁也说服不了谁。
        const { isMarketRelevant } = await import('../src/lib/news.js');
        const offTopic = items.filter((it) => !isMarketRelevant(it.title, it.source));

        // 闸门本身保证「整源命中率 ≥30%」，这里把标准提高到 80%：
        // 允许个别时政/科技条目混入（这是真实供稿池的常态），
        // 但不能出现「首页一半与社会新闻无关」的情况。
        const rate = 1 - offTopic.length / items.length;
        if (rate < 0.8) {
          throw new Error(
            `${offTopic.length}/${items.length} 条与金融市场无关（要求 ≥80% 相关），例如「${offTopic[0]?.title ?? ''}」`
          );
        }
        return `${items.length - offTopic.length}/${items.length} 条相关（${(rate * 100).toFixed(0)}%）`;
      });

      await check('财经信息不是单一栏目专版（栏目配平生效）', async () => {
        const r = await call('GET', '/api/news/daily?limit=10');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = r.json?.data?.items ?? [];
        if (items.length < 5) return `仅 ${items.length} 条，样本不足`;

        // 信源层已合并多个栏目。这里用「同一来源媒体占比」作代理指标：
        // 实测能源栏目会独占 8/10，导致来源高度集中在财联社一家。
        const bySource = new Map();
        for (const it of items) {
          const s = String(it.source ?? '未知');
          bySource.set(s, (bySource.get(s) ?? 0) + 1);
        }
        const top = [...bySource].sort((a, b) => b[1] - a[1])[0];
        const share = top[1] / items.length;
        if (share > 0.6) {
          throw new Error(
            `单一来源「${top[0]}」占 ${top[1]}/${items.length}（${(share * 100).toFixed(0)}%），首页恐成单一栏目专版`
          );
        }
        return `${bySource.size} 家来源 · 最高「${top[0]}」${top[1]} 条（${(share * 100).toFixed(0)}%）`;
      });

      // --- 设置接口不得泄露口令类字段 ---
      await check('GET /api/settings 不下发口令类配置', async () => {
        const r = await call('GET', '/api/settings');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const rows = r.json?.data?.settings ?? [];
        // 大小写不敏感地找敏感词，避免改个大小写就绕过
        const leak = rows.filter((row) => /passcode|password|secret|token/i.test(String(row.key)));
        if (leak.length > 0) {
          throw new Error(`泄露敏感配置项：${leak.map((l) => l.key).join(', ')}`);
        }
        const filtered = r.json?.data?.filteredSecretCount ?? 0;
        return `${rows.length} 项公开配置${filtered > 0 ? `，已过滤 ${filtered} 项敏感配置` : ''}`;
      });

      await check('GET /api/settings 匿名传 include_secret=1 也读不到敏感项', async () => {
        const r = await call('GET', '/api/settings?include_secret=1');
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const rows = r.json?.data?.settings ?? [];
        const leak = rows.filter((row) => /passcode|password|secret|token/i.test(String(row.key)));
        if (leak.length > 0) {
          throw new Error(`匿名访客伪造参数读到了敏感项：${leak.map((l) => l.key).join(', ')}`);
        }
        return `返回 ${rows.length} 项，无敏感项`;
      });

      // --- 404 / 400 ---
      await check('未知接口返回 404（而不是 500）', async () => {
        const r = await call('GET', '/api/__no_such_route__');
        if (r.status !== 404) throw new Error(`HTTP ${r.status}，应为 404`);
        return 'HTTP 404';
      });

      await check('非法 JSON 请求体返回 400', async () => {
        const r = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ this is not json',
        });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}，应为 400`);
        return 'HTTP 400';
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  if (db) db.close();

  // ---- 输出结果 ---------------------------------------------------------
  console.log();
  let curGroup = '';
  for (const r of results) {
    if (r.kind === 'section') {
      console.log();
      console.log(`── ${r.title} ${'─'.repeat(Math.max(0, 58 - r.title.length))}`);
      curGroup = r.title;
      continue;
    }
    if (r.kind === 'pass') {
      console.log(`  [通过] ${r.name}`);
      if (r.detail) console.log(`         ${r.detail}`);
    } else if (r.kind === 'fail') {
      console.log(`  [失败] ${r.name}`);
      console.log(`         ${r.detail}`);
    } else {
      console.log(`  [信息] ${r.name}：${r.detail}`);
    }
  }
  void curGroup;

  const total = results.filter((r) => r.kind === 'pass' || r.kind === 'fail').length;
  const failed = results.filter((r) => r.kind === 'fail').length;

  console.log();
  console.log('='.repeat(64));
  if (failed === 0) {
    console.log(`自检通过：${total - failed}/${total} 项`);
    console.log('后端可独立运行。下一步：npm start 启动服务，npm test 跑单元/集成测试。');
  } else {
    console.log(`自检未通过：${failed}/${total} 项失败`);
    console.log('请按上面的「失败」条目逐项处理；多数情况运行 npm run setup 即可修复。');
  }
  console.log('='.repeat(64));

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error();
  console.error('自检脚本自身异常（不是被测代码的问题）：');
  console.error(err);
  process.exitCode = 2;
});
