/**
 * HTTP 集成测试：真实起服务、真实发请求，验证鉴权与权限隔离。
 *
 * 为什么必须做集成测试：本项目最容易出错的不是纯函数，而是
 * 「接口是否真的做了服务端裁决」——例如列表接口曾漏过滤受限条目，
 * 匿名访客不传 restricted=1 就能拿到全部内部资料。这类缺陷只有
 * 打真实 HTTP 请求才能发现。
 *
 * 每个用例使用独立的临时 SQLite 与临时素材目录，互不污染。
 *
 * 运行：node --test "test/*.test.js"
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { createAccountService, ROLE_ADMIN, ROLE_VIEWER } from '../src/lib/accounts.js';
import { openDatabase } from '../src/lib/db.js';
import { runScan, RESTRICTED_CATEGORIES } from '../src/lib/scan.js';
import { createEnv, buildConfig } from '../src/lib/env.js';

const ADMIN_PW = 'Fia@Admin2026';
const VIEWER_PW = '<已清除>';

let server;
let baseUrl;
let workDir;
let db;

/** 启动一个隔离的测试实例 */
before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'fia-test-'));

  // 临时素材目录：1 个公开文件 + 1 个受限文件
  const materials = path.join(workDir, '素材');
  mkdirSync(path.join(materials, '公开资料'), { recursive: true });
  mkdirSync(path.join(materials, '研发部内部资料'), { recursive: true });
  writeFileSync(path.join(materials, '公开资料', '公开.pdf'), Buffer.from('%PDF-1.4 test'));
  writeFileSync(path.join(materials, '研发部内部资料', '机密.pdf'), Buffer.from('%PDF-1.4 secret'));

  const dbPath = path.join(workDir, 'test.db');
  db = openDatabase(dbPath);

  // 配置来自真实的 buildConfig()，而不是手搓一个近似对象。
  // 原因：手搓 config 会漏字段（曾经漏了 login.maxFails 与 sessionTtlHoursAdmin），
  // 导致测试报 500 却是测试自身的问题，而非被测代码的问题——这样的测试没有意义。
  // 用 createEnv 喂入显式变量，既不读磁盘 .env，又能覆盖到每一条真实默认路径。
  const env = createEnv({
    envFile: path.join(workDir, '__no_such_env__'),
    processEnv: {
      DB_PATH: dbPath,
      MATERIALS_DIR: materials,
      PORT: '0',
      HOST: '127.0.0.1',
      COOKIE_NAME: 'fia_session',
      SESSION_TTL_HOURS_ADMIN: '168',
      SESSION_TTL_HOURS_VIEWER: '24',
      CORS_ORIGINS: '',
    },
  });
  const config = buildConfig(env);

  // 建账号（createAccount 为 async，且临时账号必须带未来到期时间）
  const accounts = createAccountService(db, config);
  const created = [
    await accounts.createAccount({
      username: 'admin',
      password: ADMIN_PW,
      role: ROLE_ADMIN,
      displayName: '测试管理员',
    }),
    await accounts.createAccount({
      username: 'guest',
      password: VIEWER_PW,
      role: ROLE_VIEWER,
      displayName: '测试临时账号',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  ];
  for (const c of created) {
    assert.equal(c.ok, true, `建账号应成功：${JSON.stringify(c)}`);
  }

  // 一个已过期的临时账号，用于验证「过期作废」。
  // createAccount 会拒绝「已过去的到期时间」，所以这里直接写库，
  // 模拟「账号创建时有效、之后自然过期」的真实场景。
  await accounts.createAccount({
    username: 'expired',
    password: VIEWER_PW,
    role: ROLE_VIEWER,
    displayName: '已过期账号',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  db.prepare('UPDATE accounts SET expires_at = ? WHERE username = ?').run(
    new Date(Date.now() - 86_400_000).toISOString(),
    'expired'
  );

  // 扫描资料入库
  const scanResult = runScan(db, {
    materialsDir: materials,
    restrictedCategories: RESTRICTED_CATEGORIES,
    // 显式传空覆写表：省略会退回**生产环境**的 server/data/production-meta.json，
    // 让测试结果随生产内容的增删而漂移。夹具测试一律自己做主。
    resourceMeta: {},
  });
  assert.ok(scanResult.total >= 2, `扫描应至少入库 2 条，实际 ${scanResult.total}`);

  const app = createApp({ config, db, fingerprintSecret: 'test-fixed-secret' });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    if (db) db.close();
  } catch {
    /* 忽略 */
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** 发请求，自动跟随 cookie（用简单的手工 cookie 罐） */
async function call(method, urlPath, { body, cookie, headers } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      'user-agent': 'fia-test-agent',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如 PDF 流） */
  }
  return { status: res.status, headers: res.headers, json, text, setCookie };
}

/** 登录并返回 cookie 串 */
async function loginAs(username, password) {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  const raw = r.setCookie.find((c) => c.startsWith('fia_session='));
  assert.ok(raw, `登录 ${username} 应种下会话 cookie`);
  return raw.split(';')[0];
}

/* ─────────────────────────── 健康检查 ─────────────────────────── */

test('GET /api/health：服务可用', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.status, 'ok');
});

/* ─────────────────────────── 认证流程 ─────────────────────────── */

test('登录失败：错误口令返回 401 且不下发 cookie', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'definitely-wrong' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.setCookie.length, 0, '失败时不应下发会话 cookie');
});

test('登录失败：不存在的账号返回 401', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { username: 'no-such-user', password: ADMIN_PW },
  });
  assert.equal(r.status, 401);
});

test('登录成功：返回角色与能力，且 cookie 为 httpOnly', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PW },
  });
  assert.equal(r.status, 200, '正确口令应登录成功');
  assert.equal(r.json.data.account.role, 'admin');
  assert.ok(Array.isArray(r.json.data.account.capabilities));
  assert.ok(r.json.data.account.capabilities.includes('canManageContent'), '管理员应有内容管理能力');

  const raw = r.setCookie.find((c) => c.startsWith('fia_session='));
  assert.ok(raw, '应下发会话 cookie');
  assert.ok(/HttpOnly/i.test(raw), '会话 cookie 必须是 httpOnly，防止 JS 读取');
  assert.ok(/SameSite=/i.test(raw), '应显式声明 SameSite');
});

test('/api/auth/me：无 cookie 时返回未登录（而不是报错）', async () => {
  const r = await call('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.authenticated, false);
  assert.equal(r.json.data.role, 'guest');
});

test('/api/auth/me：带 cookie 时返回真实身份', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/auth/me', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.authenticated, true);
  assert.equal(r.json.data.account.username, 'admin');
});

test('登出后会话失效', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  // 登出前可用
  assert.equal((await call('GET', '/api/auth/me', { cookie })).json.data.authenticated, true);

  const out = await call('POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 200);

  // 登出后同一 cookie 应失效
  const after = await call('GET', '/api/auth/me', { cookie, headers: { 'cache-control': 'no-cache' } });
  assert.equal(after.json.data.authenticated, false, '登出后会话必须失效');
});

test('伪造的会话 token 不被接受', async () => {
  const r = await call('GET', '/api/auth/me', { cookie: 'fia_session=forged-token-value' });
  assert.equal(r.json.data.authenticated, false, '伪造 token 必须被拒绝');
});

/* ─────────────────────── 临时账号过期作废 ─────────────────────── */

test('临时浏览账号：有效期内可登录', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { username: 'guest', password: VIEWER_PW },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.account.role, 'viewer');
  assert.ok(r.json.data.account.expiresAt, '临时账号应有到期时间');
});

test('临时浏览账号：过期后无法登录（过期作废）', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { username: 'expired', password: VIEWER_PW },
  });
  // 过期临时账号返回 403（而非 401）：这是刻意的设计。
  // 401 会被前端理解成「口令错了」，而真实原因是「临时权限到期」——
  // 用户需要看到「请联系协会负责人重新开通」，所以必须用可区分的状态码 + 错误码。
  assert.equal(r.status, 403, '过期账号即使口令正确也必须拒绝');
  // 错误响应统一为 { ok: false, error: { code, message } }，注意 code 在 error 里
  assert.equal(r.json.error?.code, 'ACCOUNT_EXPIRED', '应给出可区分的错误码，便于前端提示续期');
});

test('临时浏览账号：不具备管理能力', async () => {
  const cookie = await loginAs('guest', VIEWER_PW);
  const me = await call('GET', '/api/auth/me', { cookie });
  const caps = me.json.data.capabilities;
  assert.ok(!caps.includes('canManageContent'), 'viewer 不应有内容管理能力');
  assert.ok(!caps.includes('canManageAccounts'), 'viewer 不应有账号管理能力');
});

/* ───────────────────── 受保护接口的权限隔离 ───────────────────── */

test('账号管理接口：无会话被拒（401）', async () => {
  const r = await call('GET', '/api/admin/accounts');
  assert.equal(r.status, 401, '匿名访问账号管理必须 401');
});

test('账号管理接口：临时浏览账号被拒（403）', async () => {
  const cookie = await loginAs('guest', VIEWER_PW);
  const r = await call('GET', '/api/admin/accounts', { cookie });
  assert.equal(r.status, 403, 'viewer 访问账号管理必须 403，不能只靠前端隐藏');
});

test('账号管理接口：管理员可访问（200）', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/admin/accounts', { cookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.data.accounts));
});

/* ───────────── 受限资料的可见性（核心防泄露用例） ───────────── */

test('资料列表：匿名访客拿不到受限条目（无论是否传 restricted 参数）', async () => {
  // 不传任何参数
  const plain = await call('GET', '/api/resources?limit=100');
  assert.equal(plain.status, 200);
  const cats = plain.json.data.items.map((i) => i.category);
  assert.ok(
    !cats.includes('研发部内部资料'),
    '匿名访客不得看到受限分类（这是曾经的真实漏洞：不传 restricted=1 就能拿到全部）'
  );

  // 显式尝试绕过
  const bypass1 = await call('GET', '/api/resources?restricted=1&limit=100');
  assert.equal(bypass1.status, 401, '匿名请求受限视图必须 401');

  const bypass2 = await call('GET', '/api/resources?visibility=member&limit=100');
  assert.ok(
    !bypass2.json.data.items.some((i) => i.category === '研发部内部资料'),
    '伪造 visibility 参数不得绕过服务端裁决'
  );
});

test('资料列表：管理员可见受限条目', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/resources?limit=100', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.canViewRestricted, true);
  assert.ok(
    r.json.data.items.some((i) => i.category === '研发部内部资料'),
    '管理员应能看到受限条目'
  );
});

test('资料统计：匿名访客的计数不含受限条目（防止从计数推断规模）', async () => {
  const anon = await call('GET', '/api/resources?limit=100');
  const cookie = await loginAs('admin', ADMIN_PW);
  const admin = await call('GET', '/api/resources?limit=100', { cookie });

  assert.ok(
    anon.json.data.summary.total < admin.json.data.summary.total,
    '匿名可见条数必须少于管理员，否则统计泄露了受限内容规模'
  );
});

test('受限资料的详情：匿名为 401，管理员为 200', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const all = await call('GET', '/api/resources?limit=100', { cookie });
  const secret = all.json.data.items.find((i) => i.category === '研发部内部资料');
  assert.ok(secret, '测试数据应包含受限条目');

  const anon = await call('GET', `/api/resources/${secret.id}`);
  assert.equal(anon.status, 401, '匿名取受限资料详情必须 401');

  const ok = await call('GET', `/api/resources/${secret.id}`, { cookie });
  assert.equal(ok.status, 200);
});

test('受限资料的下载：匿名为 401', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const all = await call('GET', '/api/resources?limit=100', { cookie });
  const secret = all.json.data.items.find((i) => i.category === '研发部内部资料');

  const anon = await call('GET', `/api/resources/${secret.id}/download`);
  assert.equal(anon.status, 401, '匿名下载受限资料必须 401');

  const ok = await call('GET', `/api/resources/${secret.id}/download`, { cookie });
  assert.equal(ok.status, 200, '管理员应能下载');
});

/* ─────────────────────── 点赞：幂等与去重 ─────────────────────── */

/**
 * 回归用例：受限条目的**写操作**也曾缺少权限闸门。
 *
 * 曾经的缺陷：detail / preview / download 都校验了 access_level，
 * 但 POST|DELETE /:id/like 只做了 id 合法性检查就直接落库，
 * 导致未登录访客既能污染受限条目的点赞数，又能从 200 响应体里
 * 读到该条目的 name / sizeText / category —— 等于绕过列表过滤拿到元数据。
 *
 * 因此点赞与取消必须与读接口共用同一道闸门。
 */
test('受限资料的点赞：匿名为 401，且不泄露条目元数据', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const all = await call('GET', '/api/resources?limit=100', { cookie });
  const secret = all.json.data.items.find((i) => i.category === '研发部内部资料');
  assert.ok(secret, '测试数据应包含受限条目');

  const like = await call('POST', `/api/resources/${secret.id}/like`);
  assert.equal(like.status, 401, '匿名给受限资料点赞必须 401');
  assert.equal(
    like.json.error?.code,
    'UNAUTHENTICATED',
    '应返回明确的未认证错误码，而不是静默成功'
  );
  // 响应体绝不能带出条目信息
  const body = JSON.stringify(like.json);
  assert.ok(!body.includes(secret.name), '拒绝响应不得回显受限条目名称');

  const unlike = await call('DELETE', `/api/resources/${secret.id}/like`);
  assert.equal(unlike.status, 401, '匿名取消受限资料点赞必须 401');

  // 有会话时应当放行
  const asAdmin = await call('POST', `/api/resources/${secret.id}/like`, { cookie });
  assert.equal(asAdmin.status, 200, '已登录成员应能点赞受限资料');
});

test('公开资料的点赞：匿名依旧放行（闸门不能误伤）', async () => {
  const list = await call('GET', '/api/resources?limit=100');
  const pub = list.json.data.items.find((i) => i.accessLevel === 'public');
  assert.ok(pub, '测试数据应包含公开条目');

  const like = await call('POST', `/api/resources/${pub.id}/like`);
  assert.equal(like.status, 200, '匿名点赞公开资料必须放行');

  await call('DELETE', `/api/resources/${pub.id}/like`);
});

test('点赞不存在的资料：返回 404 而非 500', async () => {
  const r = await call('POST', '/api/resources/999999/like');
  assert.equal(r.status, 404);
});

test('点赞：同一来源重复点赞不增加计数（去重幂等）', async () => {
  const list = await call('GET', '/api/resources?limit=1');
  const id = list.json.data.items[0].id;

  const first = await call('POST', `/api/resources/${id}/like`);
  assert.equal(first.status, 200);
  assert.equal(first.json.data.alreadyLiked, false, '首次点赞应是新增');

  const second = await call('POST', `/api/resources/${id}/like`);
  assert.equal(second.json.data.alreadyLiked, true, '第二次应识别为重复');
  assert.equal(second.json.data.likes, first.json.data.likes, '重复点赞不得增加计数');

  // 清理，避免影响其他用例
  await call('DELETE', `/api/resources/${id}/like`);
});

test('取消点赞：计数回落且可再次点赞', async () => {
  const list = await call('GET', '/api/resources?limit=1');
  const id = list.json.data.items[0].id;

  await call('POST', `/api/resources/${id}/like`);
  const un = await call('DELETE', `/api/resources/${id}/like`);
  assert.equal(un.json.data.liked, false);
  assert.equal(un.json.data.likes, 0);

  const again = await call('POST', `/api/resources/${id}/like`);
  assert.equal(again.json.data.alreadyLiked, false, '取消后应可重新点赞');
  await call('DELETE', `/api/resources/${id}/like`);
});

/* ─────────────────────────── 参数校验 ─────────────────────────── */

test('未知接口返回 404（而不是 500 空白）', async () => {
  const r = await call('GET', '/api/no-such-endpoint');
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
});

test('非法 JSON 请求体返回 400', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not json',
  });
  assert.equal(res.status, 400, '非法 JSON 应返回 400 而不是崩溃');
});

/* ─────────────────── 畸形 URL：不得返回 500，更不得杀进程 ─────────────────── */

/**
 * 回归用例（对应 P0）。
 *
 * ## 曾经的缺陷
 *
 * `matchRoute()` 用裸的 `decodeURIComponent` 解路径参数，且该调用位于
 * 请求处理 `try` **之外**。畸形百分号编码抛出的 `URIError` 于是逃逸成
 * unhandledRejection；Node 22 默认 `--unhandled-rejections=throw`，
 * **整个后端进程直接退出**（实测退出码 1）。未认证、单请求即可触发。
 *
 * ## 断言策略
 *
 * 逐条断言「状态码是 400 且不是 5xx」，并在最后发一次正常请求确认服务仍在。
 * 之所以不断言「进程活着」——那需要起子进程，代价大且易 flaky；而
 * 「畸形输入得到 400 且后续请求正常」已经蕴含了「异常被正确收口」。
 */
const MALFORMED_PATHS = [
  ['截断的多字节序列', 'GET', '/api/resources/%E4%B8%'],
  ['孤立百分号', 'GET', '/api/resources/%'],
  ['非法 UTF-8 序列', 'GET', '/api/resources/%FF%FE'],
  ['百分号后跟非十六进制', 'GET', '/api/resources/%ZZ'],
  ['下载端点的畸形参数', 'GET', '/api/resources/%E4%B8%/download'],
  ['预览端点的畸形参数', 'GET', '/api/resources/%E4%B8%/preview'],
  ['点赞端点的畸形参数', 'POST', '/api/resources/%E4%B8%/like'],
];

for (const [label, method, p] of MALFORMED_PATHS) {
  test(`畸形 URL（${label}）返回 400 而不是 5xx`, async () => {
    const r = await call(method, p);
    assert.equal(
      r.status,
      400,
      `${p} 应回 400 MALFORMED_PATH，实际 ${r.status}`
    );
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error?.code, 'MALFORMED_PATH');
  });
}

test('畸形 URL 之后服务仍然可用（异常被收口，未逃逸为 unhandledRejection）', async () => {
  // 先把所有畸形路径打一遍，再探活
  for (const [, method, p] of MALFORMED_PATHS) {
    await call(method, p);
  }
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200, '畸形请求之后 /api/health 必须仍然 200');

  // 正常业务请求也不能受影响
  const list = await call('GET', '/api/resources');
  assert.equal(list.status, 200);
  assert.equal(list.json.ok, true);
});

test('合法百分号编码照常解码（收紧校验不能误伤正常请求）', async () => {
  // %34%36 即 "46"。库里没有 id=46 的条目，因此期望 404「资料不存在」
  // —— 关键是它必须被成功解码并进入业务逻辑，而不是被判成 MALFORMED_PATH。
  const r = await call('GET', '/api/resources/%34%36');
  assert.equal(r.status, 404);
  assert.equal(r.json?.error?.code, 'NOT_FOUND');
});

test('安全解码：越界与畸形输入一律判非法', async () => {
  const { safeDecode } = await import('../src/lib/http.js');
  // 正常值
  assert.equal(safeDecode('abc'), 'abc');
  assert.equal(safeDecode('%34%36'), '46');
  assert.equal(safeDecode('%E4%B8%AD'), '中');
  // 畸形值 → null（由调用方决定如何响应，绝不抛错）
  for (const bad of ['%E4%B8%', '%', '%ZZ', '%FF%FE', '%E4%B8']) {
    assert.equal(safeDecode(bad), null, `${bad} 应判为非法`);
  }
  // NUL 注入
  assert.equal(safeDecode('%00abc'), null, '含 NUL 的值应判为非法');
});
