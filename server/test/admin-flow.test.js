/**
 * 「栏目与网站管理」端到端集成测试。
 *
 * 本文件覆盖的是**跨模块的长链路**，而不是单个函数的行为：
 *
 * ```
 * 访客提交手机号申请
 *      → 管理员在后台批准
 *      → 以手机号为账号名建号 + 生成 6 位口令
 *      → 写一条通知发件箱记录（文案逐字比对）
 *      → 新账号可以登录、能看到受限资料
 *      → 过期后一键延长、一键重置（旧会话must立刻失效）
 *      → 上传资料落盘并入库
 * ```
 *
 * 为什么必须走真实 HTTP：这条链路上最容易错的不是某个函数的返回值，
 * 而是**权限闸门是否在每个环节都真的生效**。例如「批准申请」若漏了能力校验，
 * 单元测试全绿也发现不了 —— 只有真发一个带着 viewer 会话的请求才会暴露。
 *
 * 每个用例共享一个隔离实例（临时素材目录 + 临时 SQLite），
 * 上传用例会往素材目录写文件，因此目录是按用例隔离的子目录。
 *
 * 运行：node --test "test/**\/*.test.js"
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { openDatabase } from '../src/lib/db.js';
import { createEnv, buildConfig } from '../src/lib/env.js';
import { loadResourceMeta } from '../src/lib/scan.js';
import { createThrottles, createThrottle } from '../src/lib/throttle.js';
import { sanitizeFileName, resolveUploadTarget } from '../src/routes/resources.js';
import { buildAccessNotificationText } from '../src/lib/access.js';

const ADMIN_USER = 'fia_test_admin';
const ADMIN_PW = 'Fia@Admin2026';
const VIEWER_USER = 'guest';
const VIEWER_PW = 'TestViewer@2026x';
const APPLICANT_PHONE = '13800001111';

/** 管理员会话 Cookie 值（供各用例复用，避免重复登录） */
let workDir;
let materialsDir;
/** 覆写表路径：必须与 materialsDir 一起指到临时目录，否则会污染生产那张表 */
let metaPath;
let db;
let app;
let server;
let baseUrl;

/** 手机号账号的口令（会被「批准」「续期」「重置」三个用例依次更新） */
let issuedPassword = '';
/** 手机号账号的 id */
let applicantAccountId = 0;
/** 上传用例产生的资料 id */
let uploadedId = 0;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'fia-admin-'));
  materialsDir = path.join(workDir, '素材');
  metaPath = path.join(workDir, 'production-meta.json');
  mkdirSync(path.join(materialsDir, '公开资料'), { recursive: true });
  mkdirSync(path.join(materialsDir, '研发部内部资料'), { recursive: true });
  writeFileSync(path.join(materialsDir, '公开资料', '已存在.pdf'), Buffer.from('%PDF-1.4 seed'));

  const env = createEnv({
    envFile: path.join(workDir, '__no_such_env__'),
    processEnv: {
      DB_PATH: path.join(workDir, 'test.db'),
      MATERIALS_DIR: materialsDir,
      // 覆写表也必须隔离 —— 它默认是个写死的生产路径，
      // 不指走的话上传用例会往生产的 production-meta.json 里塞测试记录
      RESOURCE_META_PATH: metaPath,
      PORT: '0',
      HOST: '127.0.0.1',
      COOKIE_NAME: 'fia_session',
      SESSION_TTL_HOURS_ADMIN: '168',
      SESSION_TTL_HOURS_VIEWER: '24',
      LOGIN_MAX_FAILS: '50',
      SEED_VIEWER_DAYS: '30',
    },
  });
  const config = buildConfig(env);

  db = openDatabase(config.dbPath);

  app = createApp({
    config,
    db,
    fingerprintSecret: 'integration-test-secret',
    /**
     * 限流额度放宽到测试够用的水平。
     *
     * 申请接口默认「3 次/小时/指纹」，而下面的用例要连续提交多次；
     * 若不放开，撞到 429 的用例会掩盖真正的断言失败。
     * 限流本身的行为由单独的小实例验证（见文件末尾）。
     */
    throttles: createThrottles({
      accessRequest: { max: 1000 },
      accessRequestGlobal: { max: 1000 },
    }),
    logger: () => {},
  });

  // 账号不经过种子脚本创建：种子会把演示口令写死，这里显式建，便于断言
  await app.accounts.createAccount({
    username: ADMIN_USER,
    password: ADMIN_PW,
    role: 'admin',
    displayName: '协会管理员',
    createdBy: 'test',
  });
  await app.accounts.createAccount({
    username: VIEWER_USER,
    password: VIEWER_PW,
    role: 'viewer',
    displayName: '临时访客',
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    createdBy: 'test',
  });

  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  app.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，测试目录可留在临时区 */
  }
});

/**
 * 发一个请求并解析 JSON。
 * 204 / 空响应体不解析，返回 `json: null`。
 *
 * @returns {Promise<{ status: number, json: any, headers: Headers, cookie: string }>}
 */
async function call(method, urlPath, { body, cookie, headers = {}, raw } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(raw ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  // 从 Set-Cookie 里取出 `name=value` 部分（后续请求直接回填）
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookieValue = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, json, headers: res.headers, cookie: cookieValue || cookie || '' };
}

/** 登录并回传会话 Cookie */
async function login(username, password) {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `登录失败：${JSON.stringify(r.json)}`);
  return r.cookie;
}

/* ═══════════════════════════ 一、权限闸门 ═══════════════════════════ */

test('未登录访问后台接口 → 401，且文案与需求一致', async () => {
  const stats = await call('GET', '/api/admin/stats');
  assert.equal(stats.status, 401);
  assert.equal(stats.json.error.code, 'UNAUTHENTICATED');
  // 需求原文：点「栏目与网站管理」若无权限，显示「没有权限，请登录管理员账号」
  assert.equal(stats.json.error.message, '没有权限，请登录管理员账号');

  // 账号管理与内容上传同样必须挡住
  for (const [method, p] of [
    ['GET', '/api/admin/access-requests'],
    ['GET', '/api/admin/notifications'],
    ['GET', '/api/admin/accounts'],
    ['GET', '/api/admin/resources/upload-options'],
  ]) {
    const r = await call(method, p);
    assert.equal(r.status, 401, `${p} 应对匿名访客返回 401`);
  }
});

test('临时浏览账号（viewer）访问后台接口 → 403，与「未登录」区分开', async () => {
  const cookie = await login(VIEWER_USER, VIEWER_PW);

  const stats = await call('GET', '/api/admin/stats', { cookie });
  assert.equal(stats.status, 403, 'viewer 有会话但能力不足，必须是 403 而不是 401');
  assert.equal(stats.json.error.code, 'FORBIDDEN');

  // 关键：viewer 不能批准申请（这是账号管理的核心写操作）
  const approve = await call('POST', '/api/admin/access-requests/1/approve', {
    cookie,
    body: { days: 30 },
  });
  assert.equal(approve.status, 403);

  // 关键：viewer 不能上传资料
  const upload = await call('POST', '/api/admin/resources/upload?categoryDir=公开资料&fileName=x.pdf', {
    cookie,
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('%PDF-1.4'),
  });
  assert.equal(upload.status, 403, 'viewer 不得上传文件');
});

test('管理员访问后台接口 → 200，且数据面板字段齐全', async () => {
  const cookie = await login(ADMIN_USER, ADMIN_PW);
  const r = await call('GET', '/api/admin/stats', { cookie });

  assert.equal(r.status, 200);
  const d = r.json.data;
  // 字段名是前端面板的契约，改名会静默破坏界面，因此逐个钉住
  for (const key of ['totalViews', 'uniqueVisitors', 'todayViews', 'last7dViews', 'since']) {
    assert.ok(key in d.views, `数据面板缺少字段 views.${key}`);
  }
  assert.equal(d.views.daily.length, 14, '趋势序列必须补齐 14 天（含无数据的天）');
  assert.ok(Array.isArray(d.accounts.viewers));
  assert.ok(d.accounts.admins.some((a) => a.username === ADMIN_USER));
  assert.ok('pending' in d.requests);
  assert.ok('pending' in d.notifications);
  assert.ok(d.serverTime, '必须回服务端时间供前端校正倒计时');
});

/* ═════════════════════ 二、申请 → 批准 → 建号 → 通知 ═════════════════════ */

test('申请接口：手机号格式非法一律拒绝', async () => {
  for (const bad of ['', '123', '23800001111', '1380000111', '138000011112', 'abcdefghijk']) {
    const r = await call('POST', '/api/access-requests', { body: { phone: bad } });
    assert.equal(r.status, 400, `手机号「${bad}」应被拒绝`);
    assert.equal(r.json.error.code, 'INVALID_PHONE');
  }
});

test('申请接口：合法手机号建档，重复提交不重复建单', async () => {
  const first = await call('POST', '/api/access-requests', {
    body: { phone: APPLICANT_PHONE, name: '张三', org: '金融学院' },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.duplicate, false);
  // 公开接口绝不回显完整手机号
  assert.equal(first.json.data.request.phoneMasked, '138****1111');
  assert.ok(!('phone' in first.json.data.request), '公开响应不得包含明文手机号');

  const again = await call('POST', '/api/access-requests', { body: { phone: APPLICANT_PHONE } });
  assert.equal(again.status, 201);
  assert.equal(again.json.data.duplicate, true, '同一号码再次提交应复用已有申请');
  assert.equal(again.json.data.request.id, first.json.data.request.id, '不应产生新申请单');
});

test('批准申请：以手机号为账号名建号 + 6 位随机口令 + 通知文案逐字一致', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  const queue = await call('GET', '/api/admin/access-requests?status=pending', { cookie: adminCookie });
  assert.equal(queue.status, 200);
  const pending = queue.json.data.requests.find((r) => r.phone === APPLICANT_PHONE);
  assert.ok(pending, '待审队列里应能看到刚才提交的申请');
  assert.equal(pending.status, 'pending');
  assert.ok(pending.phoneMasked, '列表同时给出打码号便于展示');

  const approve = await call('POST', `/api/admin/access-requests/${pending.id}/approve`, {
    cookie: adminCookie,
    body: { days: 30 },
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.json));
  const d = approve.json.data;

  assert.equal(d.account.username, APPLICANT_PHONE, '账号名必须是手机号本身');
  assert.equal(d.account.role, 'viewer');
  assert.equal(d.reused, false, '首次批准不应走续期路径');
  assert.match(d.issuedPassword, /^\d{6}$/, '口令必须是 6 位数字');
  assert.ok(d.account.phone, '账号上要留手机号，便于后台联系');

  // 通知文案由需求给定，逐字比对（含「西南财经大学 金融投资协会」中间那个空格）
  assert.equal(d.notification.to, APPLICANT_PHONE);
  assert.equal(d.notification.channel, 'outbox');
  assert.equal(
    d.notification.body,
    `您已经获得西南财经大学 金融投资协会的临时浏览权限，账号为您的手机号，随机密码为：${d.issuedPassword}`
  );
  assert.equal(d.notification.status, 'pending', '未接入短信网关时状态必须是「待发送」而不是假装的已发送');

  // 申请单状态翻转，且指向新建账号
  assert.equal(d.request.status, 'approved');
  assert.equal(d.request.accountId, d.account.id);

  // 保存口令供后续用例登录
  issuedPassword = d.issuedPassword;
  applicantAccountId = d.account.id;
});

test('新生效的手机号账号可以登录，且能读受限资料', async () => {
  const cookie = await login(APPLICANT_PHONE, issuedPassword);

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.authenticated, true);
  assert.equal(me.json.data.account.username, APPLICANT_PHONE);
  assert.deepEqual(me.json.data.account.capabilities, ['canViewRestricted']);

  // 受限资料读得到（viewer 的核心权益）
  const restricted = await call('GET', '/api/resources?restricted=1', { cookie });
  assert.equal(restricted.status, 200);

  // 但进不去后台（避免「临时账号 = 管理员」这类越权）
  const admin = await call('GET', '/api/admin/stats', { cookie });
  assert.equal(admin.status, 403);
});

test('同一手机号再次申请并批准 → 走续期路径，不报「账号已存在」', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  const req = await call('POST', '/api/access-requests', { body: { phone: APPLICANT_PHONE } });
  assert.equal(req.status, 201);
  const id = req.json.data.request.id;

  const approve = await call('POST', `/api/admin/access-requests/${id}/approve`, {
    cookie: adminCookie,
    body: { days: 30 },
  });
  assert.equal(approve.status, 200, '已存在的账号应被视为续期，而不是 409');
  assert.equal(approve.json.data.reused, true);
  assert.equal(approve.json.data.account.username, APPLICANT_PHONE);
  assert.equal(approve.json.data.account.id, applicantAccountId, '不得新建第二个同号账号');

  // 续期后原口令已被重置为新的 6 位口令
  issuedPassword = approve.json.data.issuedPassword;
  const cookie = await login(APPLICANT_PHONE, issuedPassword);
  assert.ok(cookie, '续期后应能用新口令登录');
});

/* ═══════════════════════ 三、一键延长与一键重置 ═══════════════════════ */

test('一键延长权限：从 max(现在, 原到期) 起算，而不是把剩余时间砍掉', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  const before = await call('GET', '/api/admin/accounts?role=viewer', { cookie: adminCookie });
  const target = before.json.data.accounts.find((a) => a.id === applicantAccountId);
  assert.ok(target.active, '刚批准的账号应是可用状态');
  assert.ok(target.remainingSec > 0, '应有剩余时间供倒计时显示');

  const extend = await call('POST', `/api/admin/accounts/${applicantAccountId}/extend`, {
    cookie: adminCookie,
    body: { days: 30 },
  });
  assert.equal(extend.status, 200);
  assert.equal(extend.json.data.extendedDays, 30);

  const after = extend.json.data.account;
  assert.ok(
    after.remainingSec > target.remainingSec,
    `延长后剩余时间应变长：${target.remainingSec} → ${after.remainingSec}`
  );
  // 次数只断言「+1」而不写死具体值：上一个用例（续期）也会计一次，
  // 写死数字会让这个用例在测试顺序变化时莫名其妙地失败
  assert.equal(
    after.extendedCount,
    target.extendedCount + 1,
    '延长次数应被记录（轻量审计痕迹）'
  );

  // 延长必须真的可登录 —— 否则「界面显示已延长」是假象
  await login(APPLICANT_PHONE, issuedPassword);
});

test('一键重置权限：生成新口令并**清空该账号的全部会话**', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  // 先拿一个有效的旧会话
  const oldCookie = await login(APPLICANT_PHONE, issuedPassword);
  const before = await call('GET', '/api/auth/me', { cookie: oldCookie });
  assert.equal(before.status, 200);
  assert.equal(before.json.data.authenticated, true, '重置前该会话应有效');
  const resetCountBefore = before.json.data.account.resetCount;

  const reset = await call('POST', `/api/admin/accounts/${applicantAccountId}/reset`, {
    cookie: adminCookie,
    body: {},
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal(reset.json.data.generated, true);
  assert.match(reset.json.data.issuedPassword, /^\d{6}$/);
  // 同样只断言「+1」：续期路径也会计一次重置，写死数字会让用例依赖测试顺序
  assert.equal(
    reset.json.data.account.resetCount,
    resetCountBefore + 1,
    '重置次数应被记录'
  );
  assert.ok(
    reset.json.data.revokedSessions >= 1,
    '重置必须清掉旧会话，否则拿到旧 Cookie 的人继续畅通，「重置」形同虚设'
  );

  /**
   * ⚠️ 验证会话失效**不能**用 `/api/auth/me`。
   *
   * `/api/auth/me` 与 `/api/auth/guard` 是**信息型**端点：无论登录与否都返回 200，
   * 用响应体里的 `authenticated` 表达状态 —— 这样前端初始化时不必把「没登录」
   * 当成错误来处理（是很合理的设计）。
   *
   * 后果是：拿一个已失效的 Cookie 去请求它，仍然会得到 `200 OK`。
   * 若用它来断言「会话已失效」，测试会永远通过 —— 一个不验任何东西的假绿。
   * 真正的闸门在**资源与管理接口**上（401 / 403），必须用它们来验。
   */
  const meAfter = await call('GET', '/api/auth/me', { cookie: oldCookie });
  assert.equal(meAfter.status, 200, '/api/auth/me 恒为 200，这是它的契约');
  assert.equal(meAfter.json.data.authenticated, false, '响应体里必须如实报告未登录');
  assert.equal(meAfter.json.data.role, 'guest');

  // 真正的失效证明：受限资源接口必须回 401
  const gateAfter = await call('GET', '/api/resources?restricted=1', { cookie: oldCookie });
  assert.equal(gateAfter.status, 401, '旧会话必须已经无法通过任何鉴权闸门');

  // 旧口令登不进去，新口令可以
  const withOld = await call('POST', '/api/auth/login', {
    body: { username: APPLICANT_PHONE, password: issuedPassword },
  });
  assert.equal(withOld.status, 401, '重置后旧口令必须失效');

  issuedPassword = reset.json.data.issuedPassword;
  await login(APPLICANT_PHONE, issuedPassword);
});

/* ═══════════════════════════ 四、浏览量统计 ═══════════════════════════ */

test('浏览上报计入「数据」面板，且同一访客同日同页只算一次访问', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);
  const before = await call('GET', '/api/admin/stats', { cookie: adminCookie });
  const baseTotal = before.json.data.views.totalViews;

  const pv = await call('POST', '/api/stats/pageview', { body: { path: '/#/news' } });
  assert.equal(pv.status, 204, '上报用 204，且不带响应体');

  // 同一指纹同一天重复上报同一路径应被主键吞掉
  await call('POST', '/api/stats/pageview', { body: { path: '/#/news' } });

  const after = await call('GET', '/api/admin/stats', { cookie: adminCookie });
  assert.equal(
    after.json.data.views.totalViews,
    baseTotal + 1,
    '重复上报同一天同一路径不应增加浏览量'
  );

  // 换一个路径则正常累加
  await call('POST', '/api/stats/pageview', { body: { path: '/#/resources' } });
  const final = await call('GET', '/api/admin/stats', { cookie: adminCookie });
  assert.equal(final.json.data.views.totalViews, baseTotal + 2);

  // 路径归一化：带 hash 与查询串的输入要落成同一口径
  const paths = final.json.data.views.topPaths.map((p) => p.path);
  assert.ok(paths.includes('/news'), `topPaths 应含归一化后的 /news，实际：${JSON.stringify(paths)}`);
});

test('账号分布与申请/通知计数同步反映在数据面板', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);
  const r = await call('GET', '/api/admin/stats', { cookie: adminCookie });
  const d = r.json.data;

  const viewerCount = d.accounts.viewers.length;
  assert.ok(viewerCount >= 2, `至少有 guest 与手机号账号，实际 ${viewerCount}`);
  assert.equal(
    d.accounts.activeViewers.length + d.accounts.expiredViewers.length,
    d.accounts.viewers.filter((a) => !a.revokedAt).length,
    '可用 + 已过期（未吊销）应等于未吊销总数'
  );
  assert.ok(d.requests.total >= 2, '已处理申请应计入总量');
  assert.ok(d.notifications.total >= 2, '每次批准都会产生一条通知');
});

/* ═══════════════════════ 五、上传与分类（联动建内容） ═══════════════════════ */

test('文件名净化：挡掉路径穿越、隐藏文件与无扩展名', () => {
  assert.equal(sanitizeFileName('报告.pdf'), '报告.pdf');
  // 只取末段，前缀路径被丢弃
  assert.equal(sanitizeFileName('a/b/报告.pdf'), '报告.pdf');
  assert.equal(sanitizeFileName('..\\..\\etc\\passwd.pdf'), 'passwd.pdf');
  // 反斜杠统一后仍取末段
  assert.equal(sanitizeFileName('C:\\Users\\x\\报告.pdf'), '报告.pdf');
  // Windows 保留字符被剔除
  assert.equal(sanitizeFileName('报<告>:"|?*.pdf'), '报告.pdf');
  // 拒绝项
  assert.equal(sanitizeFileName('.hidden.pdf'), null, '隐藏文件会被扫描器跳过，必须拒绝');
  assert.equal(sanitizeFileName('..pdf'), null);
  assert.equal(sanitizeFileName('无扩展名'), null, '没有扩展名就进不了分类器');
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName('a'.repeat(200) + '.pdf'), null, '超长文件名应拒绝');
});

test('上传目标解析：目录名与文件名双重校验，且越界一律拒绝', () => {
  const ok = resolveUploadTarget(materialsDir, '公开资料', '研报.pdf');
  assert.equal(ok.ok, true);
  assert.ok(ok.abs.startsWith(path.resolve(materialsDir) + path.sep), '目标必须落在素材目录内');
  assert.equal(ok.rel, '公开资料/研报.pdf');

  // 目录名里的路径符号必须被拒
  for (const badDir of ['../外', 'a/b', '.', '..', '', 'x'.repeat(50)]) {
    const r = resolveUploadTarget(materialsDir, badDir, 'x.pdf');
    assert.equal(r.ok, false, `目录名「${badDir}」必须被拒绝`);
  }
  // 文件名非法同样拒绝
  const r2 = resolveUploadTarget(materialsDir, '公开资料', '..');
  assert.equal(r2.ok, false);
});

test('上传资料：落盘 + 写覆写表 + 入库，且分类与访问级别立即生效', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);
  const fileName = '集成测试研报.pdf';
  const content = Buffer.from('%PDF-1.4 integration test content');

  const url =
    `/api/admin/resources/upload?categoryDir=${encodeURIComponent('公开资料')}` +
    `&fileName=${encodeURIComponent(fileName)}` +
    `&displayCategory=${encodeURIComponent('研报')}` +
    `&accessLevel=member` +
    `&title=${encodeURIComponent('集成测试研报')}` +
    `&tags=${encodeURIComponent('测试,集成')}`;

  const r = await call('POST', url, {
    cookie: adminCookie,
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));

  const item = r.json.data.item;
  assert.equal(item.name, '集成测试研报', '标题覆写应生效');
  assert.equal(item.displayCategory, '研报');
  assert.equal(item.accessLevel, 'member', '勾选的访问级别必须落到库里');
  assert.deepEqual(item.tags, ['测试', '集成']);
  assert.equal(r.json.data.downloadUrl, `/api/resources/${item.id}/download`);

  // 文件真的落盘了，且内容完整
  const abs = path.join(materialsDir, '公开资料', fileName);
  assert.ok(existsSync(abs), '文件应写入素材目录');
  assert.equal(readFileSync(abs).toString(), content.toString(), '写入内容应与上传一致');

  // 分类与访问级别必须写进覆写表 —— 否则下次扫描会被分类器按文件名推翻。
  // 这里直接读表断言，因为「重扫后不变」也可能是分类器恰好得出同样结论而造成的假阴性。
  const meta = loadResourceMeta(metaPath);
  const entry = meta[`公开资料/${fileName}`];
  assert.ok(entry, `覆写表应含「公开资料/${fileName}」，实际键：${JSON.stringify(Object.keys(meta))}`);
  assert.equal(entry.displayCategory, '研报');
  assert.equal(entry.accessLevel, 'member');
  assert.equal(entry.title, '集成测试研报');
  assert.deepEqual(entry.tags, ['测试', '集成']);

  // 重扫一次，分类必须保持不变（这是覆写表在生产路径上生效的硬证据）
  const rescan = await call('POST', '/api/admin/resources/rescan', { cookie: adminCookie, body: {} });
  assert.equal(rescan.status, 200, JSON.stringify(rescan.json));

  const detail = await call('GET', `/api/resources/${item.id}`, { cookie: adminCookie });
  assert.equal(detail.status, 200);
  const after = detail.json.data.item;
  assert.equal(after.displayCategory, '研报', '重扫后分类被覆盖 = 覆写表没生效');
  assert.equal(after.accessLevel, 'member');
  assert.equal(after.name, '集成测试研报');

  uploadedId = item.id;
});

test('上传的受限条目对匿名访客不可见、不可读、点赞也被挡', async () => {
  // 匿名列表里不应出现
  const list = await call('GET', '/api/resources');
  assert.equal(list.status, 200);
  assert.ok(
    !list.json.data.items.some((i) => i.id === uploadedId),
    'member 级条目不得出现在匿名列表里'
  );

  // 匿名读详情 → 401
  const detail = await call('GET', `/api/resources/${uploadedId}`);
  assert.equal(detail.status, 401);

  // 匿名点赞 → 401（写接口与读接口共用同一道闸门）
  const like = await call('POST', `/api/resources/${uploadedId}/like`);
  assert.equal(like.status, 401, '写操作不得绕过读取闸门');

  // 匿名下载 → 401
  const dl = await call('GET', `/api/resources/${uploadedId}/download`);
  assert.equal(dl.status, 401);

  // 登录后可见、可读
  const cookie = await login(APPLICANT_PHONE, issuedPassword);
  const asMember = await call('GET', `/api/resources/${uploadedId}`, { cookie });
  assert.equal(asMember.status, 200);
  assert.equal(asMember.json.data.item.name, '集成测试研报');
});

test('重名上传被拒绝，不自动改名造出副本', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);
  const fileName = '已存在.pdf';

  const r = await call(
    'POST',
    `/api/admin/resources/upload?categoryDir=${encodeURIComponent('公开资料')}&fileName=${encodeURIComponent(fileName)}`,
    {
      cookie: adminCookie,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('%PDF-1.4 dup'),
    }
  );
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'FILE_EXISTS');
});

test('上传非法分类名或展示类目一律 400，不写盘', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  const badDir = await call(
    'POST',
    '/api/admin/resources/upload?categoryDir=..&fileName=x.pdf',
    {
      cookie: adminCookie,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    }
  );
  assert.equal(badDir.status, 400);
  assert.equal(badDir.json.error.code, 'INVALID_DIR');

  const badCat = await call(
    'POST',
    `/api/admin/resources/upload?categoryDir=${encodeURIComponent('公开资料')}` +
      `&fileName=y.pdf&displayCategory=${encodeURIComponent('不存在的类目')}`,
    {
      cookie: adminCookie,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    }
  );
  assert.equal(badCat.status, 400);
  assert.equal(badCat.json.error.code, 'INVALID_CATEGORY');
  assert.ok(!existsSync(path.join(materialsDir, '公开资料', 'y.pdf')), '校验失败不得留下文件');
});

/* ═══════════════════════ 六、通知发件箱与限流 ═══════════════════════ */

test('通知发件箱：可列出、可标为已发送', async () => {
  const adminCookie = await login(ADMIN_USER, ADMIN_PW);

  const box = await call('GET', '/api/admin/notifications?status=pending', { cookie: adminCookie });
  assert.equal(box.status, 200);
  assert.ok(box.json.data.notifications.length >= 1, '批准申请后应至少有一条待发送通知');

  const first = box.json.data.notifications[0];
  assert.equal(first.channel, 'outbox');
  assert.ok(first.body.includes('随机密码为：'), '通知正文应含口令提示');
  assert.ok(first.toMasked.includes('****'), '列表展示打码号码');

  const sent = await call('POST', `/api/admin/notifications/${first.id}/sent`, {
    cookie: adminCookie,
    body: {},
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.data.notification.status, 'sent');
  assert.ok(sent.json.data.notification.sentAt);

  // 已发送后不再出现在 pending 里
  const pendingAgain = await call('GET', '/api/admin/notifications?status=pending', {
    cookie: adminCookie,
  });
  assert.ok(!pendingAgain.json.data.notifications.some((n) => n.id === first.id));
});

test('限流器：窗口内超限即拒绝，窗口过后恢复', () => {
  const t = createThrottle({ windowMs: 50, max: 2, name: 'spec' });
  assert.equal(t.hit('k').allowed, true);
  assert.equal(t.hit('k').allowed, true);
  const third = t.hit('k');
  assert.equal(third.allowed, false, '第 3 次应被拒绝');
  assert.ok(third.retryAfterSec >= 0);
  // 不同 key 互不影响
  assert.equal(t.hit('other').allowed, true);
  t.reset('k');
  assert.equal(t.hit('k').allowed, true, 'reset 后应恢复');
});

test('申请接口的全局闸门确实生效（超限回 429）', async () => {
  // 用独立的极小实例验证，避免影响上面的用例
  const dir = mkdtempSync(path.join(tmpdir(), 'fia-throttle-'));
  const env = createEnv({
    envFile: path.join(dir, '__no_such_env__'),
    processEnv: {
      DB_PATH: path.join(dir, 't.db'),
      MATERIALS_DIR: dir,
      RESOURCE_META_PATH: path.join(dir, 'meta.json'),
      PORT: '0',
      HOST: '127.0.0.1',
    },
  });
  const tiny = createApp({
    config: buildConfig(env),
    fingerprintSecret: 'throttle-test',
    throttles: createThrottles({
      accessRequest: { max: 100 },
      accessRequestGlobal: { max: 2 },
    }),
    logger: () => {},
  });
  const srv = createServer(tiny.handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const send = (phone) =>
    fetch(`${base}/api/access-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });

  assert.equal((await send('13900000001')).status, 201);
  assert.equal((await send('13900000002')).status, 201);
  const blocked = await send('13900000003');
  assert.equal(blocked.status, 429, '全局额度用尽后应返回 429，而不是继续写库');
  const body = await blocked.json();
  assert.equal(body.error.code, 'TOO_MANY_REQUESTS');

  await new Promise((r) => srv.close(r));
  tiny.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ═══════════════════ 七、畸形 URL 不得影响新端点 ═══════════════════ */

test('畸形 URL 打到新增的 :id 端点仍返回 400，且服务存活', async () => {
  // ⚠️ method 必须与路由表一致：用错方法会先撞上 404（形状不匹配），
  //    于是这个用例会「通过」却完全没验到畸形编码这条路径。
  const cases = [
    ['POST', '/api/admin/access-requests/%E4%B8%/approve'],
    ['POST', '/api/admin/access-requests/%E4%B8%/reject'],
    ['POST', '/api/admin/accounts/%E4%B8%/extend'],
    ['POST', '/api/admin/accounts/%E4%B8%/reset'],
    ['PATCH', '/api/admin/resources/%E4%B8%'],
    ['GET', '/api/resources/%E4%B8%/preview'],
    ['GET', '/api/resources/%'],
    ['GET', '/api/resources/%FF%FE'],
  ];
  for (const [method, p] of cases) {
    const r = await call(method, p, { body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 400, `${method} ${p} 应回 400，实际 ${r.status}`);
    assert.equal(r.json.error.code, 'MALFORMED_PATH');
  }
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200, '畸形请求之后服务必须仍然可用');
});

test('覆盖模板路径不算未知接口（避免前端上传后拿到 404）', async () => {
  // 这些是静态字面量段，必须排在 `:id` 之前才能被正确匹配
  const r = await call('GET', '/api/admin/resources/upload-options');
  // 匿名 → 401；401 已能证明「路由匹配到了处理器」，若匹配失败会是 404
  assert.equal(r.status, 401, 'upload-options 必须匹配到处理器而不是被 :id 吃掉');
});
