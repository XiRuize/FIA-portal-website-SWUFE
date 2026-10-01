/**
 * HTTP 集成测试：资料展示类目 + 财经时事归档。
 *
 * 对应老板本轮提的四条要求中的 1/2/3：
 *   1. 「不要把公司 logo 放到资料与数据中」
 *   2. 「资料与数据按 全部/电子书籍/数据/研报/课程资源 整理分类」
 *   3. 「保存一周的财经信息，点击切换」（归档 + 按日期取用）
 *
 * 为什么单独开一个文件而不并进 api.test.js：
 * api.test.js 已经 450 行，且它的夹具是「2 个通用文件」；
 * 这里需要一批**特定扩展名与文件名**的夹具才能验证分类归集。
 * 分开后两边的 before/after 各自独立，互不干扰。
 *
 * 运行：node --test "test/**\/*.test.js"
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { createAccountService, ROLE_ADMIN } from '../src/lib/accounts.js';
import { openDatabase } from '../src/lib/db.js';
import { runScan, RESTRICTED_CATEGORIES } from '../src/lib/scan.js';
import { createEnv, buildConfig } from '../src/lib/env.js';

const ADMIN_PW = 'Fia@Admin2026';

/**
 * 显式传入的**空**覆写表。
 *
 * `runScan` 的 `config.resourceMeta` 省略时会回退到 `loadResourceMeta()` 的默认路径，
 * 也就是**生产环境**的 `server/data/production-meta.json`。测试若吃到生产覆写表：
 * 1. 会拿到不该有的数据（本次实测：生产表给 `DeepSeek_DataRoom.rar` 标了「研发部」，
 *    导致「未标部门时各部门份数应为 0」的断言炸成 1）；
 * 2. 断言结果会随生产内容的增删而**随机失败** —— 这种漂移比直接失败更难排查。
 *
 * 因此凡是有自己夹具的测试，一律显式传空表，把隔离面收紧到极致。
 */
const NO_META = {};

let server;
let baseUrl;
let workDir;
let db;

/** 带 cookie 的请求小工具 */
async function call(method, urlPath, { cookie, body } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      'user-agent': 'fia-test-agent',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  return { status: res.status, headers: res.headers, setCookie, json, text };
}

/** 登录并返回可直接塞进 Cookie 头的字符串 */
async function loginAs(username, password) {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `登录失败：${r.text}`);
  assert.ok(r.setCookie.length > 0, '登录应下发 Cookie');
  return r.setCookie.map((c) => c.split(';')[0]).join('; ');
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'fia-cat-'));

  /*
   * 夹具刻意造出「同类目跨目录」的形态：
   *   - logo/          → 应被完全排除
   *   - 培训部分享资料/ → 含电子书(epub)、数据(xlsx)、课程(pdf)、研报(pdf)
   *   - 研发部内部资料/ → 含研报与课程，是受限目录
   * 这样能验证「展示类目与磁盘目录解耦」而不是「一个目录一个类目」。
   */
  const materials = path.join(workDir, '素材');
  const dirs = ['logo', '培训部分享资料', '研发部内部资料'];
  for (const d of dirs) mkdirSync(path.join(materials, d), { recursive: true });

  const files = [
    // logo：必须被排除
    ['logo', '中信证券.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['logo', '中国银行.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    // 电子书籍：靠扩展名
    ['培训部分享资料', '聪明的投资者.epub', Buffer.from('PK\u0003\u0004 epub stub')],
    ['研发部内部资料', '手把手教你读财报.epub', Buffer.from('PK\u0003\u0004 epub stub')],
    // 数据：表格扩展名 + 电话会议纪要
    ['研发部内部资料', '行业主题基金定量跟踪月报.xlsx', Buffer.from('PK\u0003\u0004 xlsx stub')],
    ['研发部内部资料', '2026 年中报电话会议全文.docx', Buffer.from('PK\u0003\u0004 docx stub')],
    // 研报：日期前缀 / 机构名 / 兜底
    ['培训部分享资料', '2026-08-21 汇川技术(A).pdf', Buffer.from('%PDF-1.4 a')],
    ['培训部分享资料', 'Morgan Stanley - 全球半导体前景.pdf', Buffer.from('%PDF-1.4 b')],
    ['研发部内部资料', '大摩——北美半导体周报.pdf', Buffer.from('%PDF-1.4 c')],
    // 课程资源：分享体裁 / 压缩包
    ['培训部分享资料', '金投暑期分享8.15.pdf', Buffer.from('%PDF-1.4 d')],
    ['研发部内部资料', 'DeepSeek_DataRoom.rar', Buffer.from('Rar!\u001a\u0007\u0000 rar stub')],
  ];
  for (const [dir, name, buf] of files) {
    writeFileSync(path.join(materials, dir, name), buf);
  }

  const dbPath = path.join(workDir, 'test.db');
  db = openDatabase(dbPath);

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

  const accounts = createAccountService(db, config);
  const created = await accounts.createAccount({
    username: 'admin',
    password: ADMIN_PW,
    role: ROLE_ADMIN,
    displayName: '测试管理员',
  });
  assert.equal(created.ok, true, `建账号应成功：${JSON.stringify(created)}`);

  const scanResult = runScan(db, {
    materialsDir: materials,
    restrictedCategories: RESTRICTED_CATEGORIES,
    // 显式传空表，切断对生产覆写表 server/data/production-meta.json 的默认回退。
    // 不隔离的话，测试断言会随生产数据的增删而随机失败 —— 详见下方「部门」用例的说明。
    resourceMeta: NO_META,
  });
  assert.equal(
    scanResult.total,
    files.length,
    `扫描应入库全部 ${files.length} 个文件，实际 ${scanResult.total}`
  );

  const fingerprintSecret = 'test-fixed-secret';
  const app = createApp({ config, db, fingerprintSecret });
  // ⚠️ createApp 返回的是 `{ handler, ctx, db, ... }` 容器，不是请求处理函数。
  // 直接 createServer(app) 会得到一个永远不响应的服务：请求挂住直到超时，
  // 且没有任何报错，排查成本极高（本次实测踩过）。
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
});

/* ───────────────── 要求 1：logo 排除 ───────────────── */

test('资料列表：logo 不进「资料与数据」', async () => {
  const r = await call('GET', '/api/resources?limit=200');
  assert.equal(r.status, 200);
  assert.equal(
    r.json.data.items.filter((i) => i.category === 'logo').length,
    0,
    '公司 logo 属于首页展示素材，不得出现在资料清单里'
  );
  assert.ok(
    !r.json.data.categories.some((c) => c.category === 'logo'),
    '分类统计不得包含 logo'
  );
  assert.ok(
    !r.json.data.categories.some((c) => c.category === '全部' && c.count > 9),
    '「全部」不应把 2 个 logo 计进去'
  );
});

test('资料扫描：logo 仍在库中（只是不下发给资料接口）', () => {
  // 排除是「展示层」的行为。若扫描阶段就直接丢弃，
  // 以后想用 logo 做首页展示就没数据了 —— 这里锁死这个边界。
  const n = db.prepare("SELECT COUNT(*) AS n FROM resources WHERE category_dir = 'logo'").get();
  assert.equal(Number(n.n), 2, 'logo 应保留在数据库中，仅由展示层过滤');
});

/* ───────────────── 要求 2：五类归集 ───────────────── */

test('分类统计：顺序固定为 全部/电子书籍/数据/研报/课程资源', async () => {
  const r = await call('GET', '/api/resources?limit=200');
  assert.deepEqual(
    r.json.data.categories.map((c) => c.category),
    ['全部', '电子书籍', '数据', '研报', '课程资源']
  );
});

test('分类统计：「全部」等于四个实体类目之和，且带 aggregate 标记', async () => {
  const r = await call('GET', '/api/resources?limit=200');
  const cats = r.json.data.categories;
  const all = cats.find((c) => c.category === '全部');
  assert.equal(all.aggregate, true, '「全部」必须标记为聚合项');
  const parts = cats.filter((c) => !c.aggregate).reduce((s, c) => s + c.count, 0);
  assert.equal(all.count, parts, '「全部」份数必须与四类之和一致，否则读者会觉得数字对不上账');
});

test('分类归集：跨目录同类目能正确合并', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/resources?limit=200', { cookie });
  const byName = Object.fromEntries(r.json.data.categories.map((c) => [c.category, c.count]));

  // 电子书籍：培训部 1 个 + 研发部 1 个 = 2
  assert.equal(byName['电子书籍'], 2, '电子书籍应跨目录合并');
  // 数据：xlsx 1 + 会议纪要 1 = 2
  assert.equal(byName['数据'], 2, '会议纪要应归「数据」而非「研报」');
  // 研报：日期前缀 1 + Morgan 1 + 大摩 1 = 3
  assert.equal(byName['研报'], 3);
  // 课程资源：分享 1（rar 已改判「社团成员产出」，见下一条用例）
  assert.equal(byName['课程资源'], 1);
  // 2+2+3+1 = 8
  //
  // ⚠️ 2026-09-27 口径调整：`DeepSeek_DataRoom.rar` 由「课程资源」改判「社团成员产出」，
  //    它因此**移出**资料库模块，「全部」从 9 变为 8。
  //    这正是两个模块分离的意义 —— 产出作品不应计入「资料与数据」的合计，
  //    否则读者会看到「全部 9 份」但四个标签加起来只有 8 份。
  //    fixtures 共 11 行，其中 logo 2 行（不计入资料库）、DataRoom 1 行（移入产出模块）→ 8 行。
  assert.equal(byName['全部'], 8, '「全部」应等于 8 个资料库条目（不含 logo 与产出作品）');
});

test('模块作用域：产出作品只出现在 productions，资料库模块看不到它', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);

  // 1) 资料库模块（默认）：不应含社团成员产出
  const lib = await call('GET', '/api/resources?limit=200', { cookie });
  assert.equal(lib.status, 200);
  assert.equal(lib.json.data.module, 'library');
  assert.ok(
    lib.json.data.items.every((i) => i.displayCategory !== '社团成员产出'),
    '资料库模块混入了产出作品'
  );
  assert.deepEqual(
    lib.json.data.categories.map((c) => c.category),
    ['全部', '电子书籍', '数据', '研报', '课程资源'],
    '资料库的标签里不应出现「社团成员产出」'
  );

  // 2) 产出模块：只含产出作品，且可见（受限目录内的作品对已登录账号可见）
  const prod = await call('GET', '/api/resources?module=productions&limit=200', { cookie });
  assert.equal(prod.status, 200);
  assert.equal(prod.json.data.module, 'productions');
  assert.ok(prod.json.data.total > 0, '产出模块应有条目');
  assert.ok(
    prod.json.data.items.every((i) => i.displayCategory === '社团成员产出'),
    '产出模块混入了资料库条目'
  );

  // 3) 两个模块相加 = 全部非 logo 条目（正向断言：一个不多、一个不少）
  //
  // fixtures 共 11 个文件，其中 2 个 logo 不属于任何模块 → 9 个条目应被整除，
  // 8 个在资料库、1 个在产出模块。若某天改动让条目在两个模块间「漏掉」或
  // 「重复」，这条断言会先炸，而不是等读者发现数字对不上。
  assert.equal(
    lib.json.data.total + prod.json.data.total,
    9,
    '两个模块的条目数之和应等于全部非 logo 条目'
  );
});

test('displayCategory 过滤：每个类目只返回自己的条目', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  for (const name of ['电子书籍', '数据', '研报', '课程资源']) {
    const r = await call(
      'GET',
      `/api/resources?limit=200&displayCategory=${encodeURIComponent(name)}`,
      { cookie }
    );
    assert.equal(r.status, 200);
    assert.ok(r.json.data.total > 0, `「${name}」应有条目`);
    assert.ok(
      r.json.data.items.every((i) => i.displayCategory === name),
      `「${name}」的结果里混入了别的类目：${JSON.stringify(
        r.json.data.items.map((i) => `${i.name}=${i.displayCategory}`)
      )}`
    );
  }
});

test('displayCategory=全部 等价于不过滤', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const all = await call('GET', '/api/resources?limit=200', { cookie });
  const explicit = await call(
    'GET',
    `/api/resources?limit=200&displayCategory=${encodeURIComponent('全部')}`,
    { cookie }
  );
  assert.equal(explicit.json.data.total, all.json.data.total);
});

test('displayCategory：未知类目安静返回空集，不报 500', async () => {
  const r = await call(
    'GET',
    `/api/resources?limit=200&displayCategory=${encodeURIComponent('不存在的类目')}`
  );
  assert.equal(r.status, 200, '未知类目应是空集，不是错误');
  assert.equal(r.json.data.total, 0);
});

test('displayCategory：访客视图下不绕过受限裁剪', async () => {
  const anon = await call('GET', '/api/resources?limit=200&displayCategory=研报');
  assert.equal(anon.status, 200);
  assert.ok(
    !anon.json.data.items.some((i) => i.accessLevel === 'member'),
    '类目过滤不得成为绕过可见性裁决的后门'
  );

  // 管理员应当能看到更多研报（受限目录里还有）
  const cookie = await loginAs('admin', ADMIN_PW);
  const admin = await call('GET', '/api/resources?limit=200&displayCategory=研报', { cookie });
  assert.ok(
    admin.json.data.total > anon.json.data.total,
    '管理员在「研报」下应看到比访客更多的条目'
  );
});

test('toPublic 同时给出磁盘目录与展示类目（两者不可混用）', async () => {
  // 必须带 admin 会话：'研发部内部资料' 是受限目录，
  // 匿名请求拿不到那条，会误判成「夹具缺失」。
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/resources?limit=200', { cookie });
  // 按名字取，不依赖列表顺序：夹具里有两个 epub，
  // 用 find(i => ext === 'epub') 会随排序变化而取到不同的那条。
  const epub = r.json.data.items.find((i) => i.name === '手把手教你读财报');
  assert.ok(epub, '夹具里应有《手把手教你读财报》');
  assert.equal(epub.category, '研发部内部资料', 'category 是磁盘目录（给整理者）');
  assert.equal(epub.displayCategory, '电子书籍', 'displayCategory 是展示类目（给读者）');

  // 另一个 epub 在公开目录里，两个类目字段的取值都应随之不同
  const epub2 = r.json.data.items.find((i) => i.name === '聪明的投资者');
  assert.ok(epub2, '夹具里应有《聪明的投资者》');
  assert.equal(epub2.category, '培训部分享资料');
  assert.equal(epub2.displayCategory, '电子书籍', '同类目应跨目录合并');
});

/* ───────────────── 部门维度：产出页顶部的纵向筛选 ───────────────── */

/**
 * 这个夹具文件里**没有**产出作品的部门标注，所以所有产出条目的
 * `department` 都是空串。这恰好覆盖两个关键边界：
 * 1. 未标部门的作品必须仍出现在「全部」下（不能被静默丢掉）；
 * 2. 它们**不得**出现在任何具体部门标签下。
 *
 * ⚠️ 为此 `runScan` **必须显式传 `resourceMeta: {}`**。
 * 不传的话它会退回 `loadResourceMeta()` 的默认路径 —— 那是**生产环境**的
 * `server/data/production-meta.json`，里面已经标了部门。测试读到生产覆写表，
 * 既会拿到不该有的部门数据，也会让断言随生产数据变动而随机失败
 * （本次实测踩过：本文件里 `DeepSeek_DataRoom.rar` 被生产覆写表贴上了「研发部」，
 *   于是「各部门份数应为 0」的断言炸成了 1）。
 *
 * 传空对象是**刻意收紧隔离面**：这条测试要验证的是「未标部门」这个状态本身，
 * 让外部数据渗进来就测不出任何东西了。常量 `NO_META` 定义在文件顶部。
 */
test('部门：资料模块不返回 departments 字段（它没有部门概念）', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/resources?limit=200', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.module, 'library');
  assert.equal(
    r.json.data.departments,
    undefined,
    '资料模块不应回 departments —— 回一个全 0 数组会诱使前端渲染出没用的空标签'
  );
});

test('部门：产出模块返回固定顺序的三个部门，且不含「全部」聚合项', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const r = await call('GET', '/api/resources?module=productions&limit=200', { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.data.departments.map((d) => d.department),
    ['研发部', '培训部', '宣传中心'],
    '部门顺序由后端 PRODUCTION_DEPARTMENTS 给定，前端不自行排序'
  );
  assert.ok(
    !r.json.data.departments.some((d) => d.department === '全部'),
    '「全部」的份数由 total 提供，出现在这里会造成两个来源不一致'
  );
  // 空部门也要保留（count = 0），前端标签才齐全、不会因数据缺失而抖动
  assert.ok(
    r.json.data.departments.every((d) => typeof d.count === 'number'),
    '每个部门都要给出数字（可为 0）'
  );
});

test('部门：未标部门的作品仍在「全部」下可见，但不进任何部门标签', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const all = await call('GET', '/api/resources?module=productions&limit=200', { cookie });
  assert.ok(all.json.data.total > 0, '夹具里应有产出作品（受限目录，需 admin 会话）');

  assert.ok(
    all.json.data.departments.every((d) => d.count === 0),
    `本夹具未标部门，各部门份数应为 0，实际 ${JSON.stringify(all.json.data.departments)}`
  );
  assert.ok(
    all.json.data.items.every((i) => i.department === ''),
    '未标部门时应回空串，而不是 undefined 或占位文案'
  );
});

test('部门：筛选某个部门时只返回该部门的作品', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  for (const dept of ['研发部', '培训部', '宣传中心']) {
    const r = await call(
      'GET',
      `/api/resources?module=productions&limit=200&department=${encodeURIComponent(dept)}`,
      { cookie }
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.json.data.total,
      0,
      `本夹具没有「${dept}」的作品，应安静返回空集，而不是回退成全量`
    );
  }
});

test('部门=全部 等价于不按部门过滤', async () => {
  const cookie = await loginAs('admin', ADMIN_PW);
  const plain = await call('GET', '/api/resources?module=productions&limit=200', { cookie });
  const explicit = await call(
    'GET',
    `/api/resources?module=productions&limit=200&department=${encodeURIComponent('全部')}`,
    { cookie }
  );
  assert.equal(
    explicit.json.data.total,
    plain.json.data.total,
    '「全部」与不传参数必须是同一口径'
  );
});

test('部门：未知部门安静返回空集，不报 500', async () => {
  const r = await call(
    'GET',
    `/api/resources?module=productions&limit=200&department=${encodeURIComponent('不存在的部门')}`
  );
  assert.equal(r.status, 200, '未知部门应是空集，不是错误');
  assert.equal(r.json.data.total, 0);
});

test('部门：访客视图下不绕过受限裁剪', async () => {
  const anon = await call('GET', '/api/resources?module=productions&limit=200&department=研发部');
  assert.equal(anon.status, 200);
  assert.ok(
    !anon.json.data.items.some((i) => i.accessLevel === 'member'),
    '部门筛选不得成为绕过可见性裁决的后门'
  );
  // 访客的部门计数同样要按可见性裁剪，不能从计数上看出受限作品规模
  const anonAll = await call('GET', '/api/resources?module=productions&limit=200');
  const sumAnon = anonAll.json.data.departments.reduce((s, d) => s + d.count, 0);
  const cookie = await loginAs('admin', ADMIN_PW);
  const adminAll = await call('GET', '/api/resources?module=productions&limit=200', { cookie });
  const sumAdmin = adminAll.json.data.departments.reduce((s, d) => s + d.count, 0);
  assert.ok(
    sumAnon <= sumAdmin,
    `访客看到的部门合计（${sumAnon}）不应超过管理员（${sumAdmin}）`
  );
});

/**
 * 独立夹具：造出「三个部门 + 一条未标部门」四种形态，验证部门的
 * 归属、计数与筛选真正生效 —— 而不是只验证「没标部门时返回 0」。
 *
 * 为什么另起一个库：本文件的 before() 已经锁定了一套「展示类目」夹具，
 * 往里加部门标注会牵动上面若干条类目断言的数字。部门是独立维度，
 * 用独立库验证更不容易互相污染。
 */
test('部门：独立夹具下按部门归属、计数与筛选都正确', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fia-dept-'));
  const materials = path.join(dir, '素材');
  mkdirSync(path.join(materials, '研发部内部资料'), { recursive: true });

  // 四个产出作品。
  // ⚠️ 文件名必须能**自动**归类为「社团成员产出」（命中 dataroom / 尽调 / 每日新闻），
  // 否则第 4 条会被归成资料条目、根本不出现在产出模块里 —— 那样测的就不是部门
  // 而是覆写表了。这里刻意不靠 displayCategory 覆写来凑。
  const files = [
    ['DeepSeek_DataRoom.rar', 'aaa'],
    ['每日新闻汇总.rar', 'bbb'],
    ['小红书_DataRoom.zip', 'ccc'],
    ['尽调资料包.pdf', 'ddd'],
  ];
  for (const [name, body] of files) {
    writeFileSync(path.join(materials, '研发部内部资料', name), Buffer.from(`Rar!\u001a\u0007\u0000 ${body}`));
  }

  const metaPath = path.join(dir, 'meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify({
      items: {
        // 三条各有明确部门
        '研发部内部资料/DeepSeek_DataRoom.rar': { department: '研发部' },
        '研发部内部资料/每日新闻汇总.rar': { department: '培训部' },
        '研发部内部资料/小红书_DataRoom.zip': { department: '宣传中心' },
        // 第四条**刻意不写 department**：验证未标部门的作品仍在「全部」下
        '研发部内部资料/尽调资料包.pdf': { tags: ['未标部门'] },
      },
    }),
    'utf8'
  );

  const dbPath = path.join(dir, 'dept.db');
  const deptDb = openDatabase(dbPath);
  try {
    const metaTable = JSON.parse(readFileSync(metaPath, 'utf8')).items;
    runScan(deptDb, {
      materialsDir: materials,
      restrictedCategories: RESTRICTED_CATEGORIES,
      resourceMeta: metaTable,
    });

    const env = createEnv({
      envFile: path.join(dir, '__no_such_env__'),
      processEnv: {
        DB_PATH: dbPath,
        MATERIALS_DIR: materials,
        PORT: '0',
        HOST: '127.0.0.1',
        COOKIE_NAME: 'fia_session_dept',
        SESSION_TTL_HOURS_ADMIN: '168',
        CORS_ORIGINS: '',
      },
    });
    const deptConfig = buildConfig(env);
    const deptAccounts = createAccountService(deptDb, deptConfig);
    const pw = 'Fia@Dept2026';
    await deptAccounts.createAccount({
      username: 'deptadmin',
      password: pw,
      role: ROLE_ADMIN,
      displayName: '部门测试管理员',
    });
    const deptApp = createApp({
      config: deptConfig,
      db: deptDb,
      fingerprintSecret: 'dept-secret',
    });
    const deptServer = createServer(deptApp.handler);
    await new Promise((resolve) => deptServer.listen(0, '127.0.0.1', resolve));
    const deptBase = `http://127.0.0.1:${deptServer.address().port}`;

    /**
     * 带会话的请求。
     *
     * ⚠️ 必须带 admin 会话：本夹具的产出作品放在「研发部内部资料」里，
     * 那是 `RESTRICTED_CATEGORIES` 里的受限目录 —— 匿名请求会被后端裁成空集，
     * 于是「四个作品都应可见」的断言会炸成 0，而失败原因看起来像是「部门没生效」，
     * 实际是**没登录**。这个假象本次实际踩过一次。
     */
    const login = async () => {
      const res = await fetch(`${deptBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'deptadmin', password: pw }),
      });
      const cookies = res.headers.getSetCookie?.() ?? [];
      assert.equal(res.status, 200, '独立夹具的登录应成功');
      assert.ok(cookies.length > 0, '登录应下发 Cookie');
      return cookies.map((c) => c.split(';')[0]).join('; ');
    };

    const cookie = await login();
    const get = async (p) => {
      const res = await fetch(`${deptBase}${p}`, { headers: { cookie } });
      return { status: res.status, json: await res.json() };
    };

    try {
      const all = await get('/api/resources?module=productions&limit=200');
      assert.equal(all.status, 200);
      assert.equal(all.json.data.total, 4, '四个产出作品都应可见');

      const byDept = Object.fromEntries(
        all.json.data.departments.map((d) => [d.department, d.count])
      );
      assert.equal(byDept['研发部'], 1);
      assert.equal(byDept['培训部'], 1);
      assert.equal(byDept['宣传中心'], 1);
      assert.equal(
        Object.values(byDept).reduce((s, n) => s + n, 0),
        3,
        '各部门之和应是 3 —— 未标部门的那条不计入任何部门'
      );

      // 未标部门的那条：在「全部」下能找到，且 department 为空串
      const orphan = all.json.data.items.find((i) => i.name === '尽调资料包');
      assert.ok(orphan, '未标部门的作品必须仍出现在「全部」下，否则等于凭空消失');
      assert.equal(orphan.department, '');

      // 逐部门筛选：每个部门各回 1 条，且就是自己那条
      const expected = {
        研发部: 'DeepSeek_DataRoom',
        培训部: '每日新闻汇总',
        宣传中心: '小红书_DataRoom',
      };
      for (const [dept, name] of Object.entries(expected)) {
        const r = await get(
          `/api/resources?module=productions&limit=200&department=${encodeURIComponent(dept)}`
        );
        assert.equal(r.json.data.total, 1, `「${dept}」应恰有 1 条`);
        assert.equal(r.json.data.items[0].name, name);
        assert.equal(r.json.data.items[0].department, dept);
      }

      // 关键反证：按部门筛选时，未标部门的那条**不得**出现在任何部门下
      for (const dept of ['研发部', '培训部', '宣传中心']) {
        const r = await get(
          `/api/resources?module=productions&limit=200&department=${encodeURIComponent(dept)}`
        );
        assert.ok(
          !r.json.data.items.some((i) => i.name === '尽调资料包'),
          `未标部门的作品混进了「${dept}」`
        );
      }
    } finally {
      await new Promise((resolve) => deptServer.close(resolve));
    }
  } finally {
    try {
      deptDb.close();
    } catch {
      /* 已关闭 */
    }
  }
});



test('财经时事：/api/news/dates 返回归档日期与保留天数', async () => {
  const r = await call('GET', '/api/news/dates');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.data.dates));
  assert.equal(typeof r.json.data.keepDays, 'number');
  assert.ok(r.json.data.keepDays >= 7, `保留天数应至少 7 天，实际 ${r.json.data.keepDays}`);
});

test('财经时事：非法日期返回 400 INVALID_DATE（不静默当成今天）', async () => {
  const bad = ['2026-9-20', '20260920', 'today', '2026-13-45', '2026/09/20'];
  for (const d of bad) {
    const r = await call('GET', `/api/news/daily?date=${encodeURIComponent(d)}`);
    assert.equal(r.status, 400, `日期「${d}」应被拒绝，实际 ${r.status}`);
    assert.equal(r.json.error.code, 'INVALID_DATE');
  }
});

test('财经时事：合法但无归档的日期返回空集 + stale', async () => {
  const r = await call('GET', '/api/news/daily?date=2000-01-01');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.date, '2000-01-01');
  assert.equal(r.json.data.requestedDate, '2000-01-01');
  assert.equal(r.json.data.total, 0);
  assert.equal(r.json.data.stale, true, '无缓存的非当日应标 stale，前端据此如实提示');
});

test('财经时事：历史日期只读归档，不触发抓取', async () => {
  // 用**保留窗口内**的日期（3 天前）。
  // 之前用固定的 '2026-01-05'，在 9 月跑时已超出 7 天窗口，
  // availableDates 会正确过滤掉它 —— 那时失败的是测试而非代码。
  const d = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO news_items
       (bucket_date, rank_index, title, url, published_at, source, likes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  );
  ins.run(
    d,
    1,
    '归档回归 A',
    'https://finance.eastmoney.com/a/901.html',
    `${d}T09:00:00.000Z`,
    '证券时报',
    now
  );
  ins.run(
    d,
    2,
    '归档回归 B',
    'https://finance.eastmoney.com/a/902.html',
    `${d}T08:00:00.000Z`,
    '券商中国',
    now
  );

  const r = await call('GET', `/api/news/daily?date=${d}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.date, d);
  assert.equal(r.json.data.total, 2);
  assert.ok(r.json.data.fromCache, '历史日期必须走缓存');
  // 关键：不能因为读历史就顺手抓当日（那会让接口变慢且污染归档）
  assert.deepEqual(
    r.json.data.items.map((i) => i.title),
    ['归档回归 A', '归档回归 B'],
    '归档条目应按 rank_index 稳定返回'
  );

  // 归档列表应包含这一天
  const dates = await call('GET', '/api/news/dates');
  assert.ok(
    dates.json.data.dates.some((x) => x.date === d && x.count === 2),
    `归档列表应包含 ${d} 且条数为 2，实际 ${JSON.stringify(dates.json.data.dates)}`
  );
});

test('财经时事：归档天数超过保留窗口的旧数据不再出现在列表里', async () => {
  // 直接写一条 30 天前的记录（保留窗口是 7 天）
  const old = new Date(Date.now() - 30 * 86_400_000);
  const bucket = old.toISOString().slice(0, 10);
  db.prepare(
    `INSERT OR REPLACE INTO news_items
       (bucket_date, rank_index, title, url, published_at, source, likes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    bucket,
    1,
    '很久以前的条目',
    'https://finance.eastmoney.com/a/903.html',
    old.toISOString(),
    '证券时报',
    new Date().toISOString()
  );

  const r = await call('GET', '/api/news/dates');
  assert.ok(
    !r.json.data.dates.some((d) => d.date === bucket),
    `保留窗口（${r.json.data.keepDays} 天）外的日期不该出现在归档列表里`
  );
});
