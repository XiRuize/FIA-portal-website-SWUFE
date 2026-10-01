/**
 * SQLite 访问层（基于 Node 内置 `node:sqlite`，无第三方依赖）。
 *
 * 为什么用 `node:sqlite` 而不是 better-sqlite3：
 * 后端要求「轻量、易维护、可独立部署」，内置模块免去原生编译（Windows 上
 * 编译 better-sqlite3 需要 vs build tools），`pnpm install` 也不会新增负担。
 * 代价：Node 会打印一条实验性警告，启动脚本已做抑制。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 建表语句：全部使用 IF NOT EXISTS，可重复执行 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 账号表：两类角色共用，用 role 区分
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  -- 口令哈希（scrypt），格式：scrypt$N$r$p$saltBase64$hashBase64。绝不存明文。
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  display_name  TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  -- 临时账号的到期时间（ISO8601）。NULL = 永不过期（管理账号通常为 NULL）
  expires_at    TEXT,
  revoked_at    TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'system',
  updated_at    TEXT NOT NULL,
  password_changed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_role ON accounts(role);

-- 会话表：登录后签发随机 token，仅存哈希，支持登出与吊销
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

-- 登录失败限流：按「账号 + IP」计数
CREATE TABLE IF NOT EXISTS login_attempts (
  scope        TEXT PRIMARY KEY,   -- username|ip（小写归一化）
  fail_count   INTEGER NOT NULL DEFAULT 0,
  first_at     TEXT NOT NULL,
  locked_until TEXT
);

-- 资料清单：由 scripts/scan-resources.mjs 扫描素材目录生成
CREATE TABLE IF NOT EXISTS resources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 相对素材根目录的 POSIX 风格路径，作为稳定业务主键（文件改名=新条目）
  rel_path     TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,   -- 不含扩展名的文件名
  file_name    TEXT NOT NULL,   -- 完整文件名（含扩展名）
  category_dir TEXT NOT NULL,   -- 一级分类目录名，如「培训部分享资料」（存放位置）
  -- 展示类目：电子书籍 / 数据 / 研报 / 课程资源。
  -- 与 category_dir 解耦 —— 存放位置是给整理者看的，读者关心的是内容形态。
  display_category TEXT NOT NULL DEFAULT '研报',
  ext          TEXT NOT NULL,   -- 小写扩展名，不含点
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  mtime        TEXT NOT NULL,   -- 文件系统修改时间（展示为「上传时间」）
  kind         TEXT NOT NULL DEFAULT 'file',  -- file | image | archive | doc
  -- 访问级别：public 所有访客可见；member 需要有效会话（临时账号亦可）
  access_level TEXT NOT NULL DEFAULT 'public' CHECK (access_level IN ('public', 'member')),
  -- 作品属性（仅「社团成员产出」使用，资料条目留空）
  author       TEXT NOT NULL DEFAULT '',
  author_title TEXT NOT NULL DEFAULT '',
  author_note  TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  screenshots  TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '',
  -- 部门：社团成员产出页面的纵向筛选维度（研发部 / 培训部 / 宣传中心）。
  -- 与 display_category 是**正交**的两件事：后者决定记录归属哪个模块，
  -- 前者只在产出模块内部再切一刀。允许空串（未标部门的作品仍在「全部」下）。
  department   TEXT NOT NULL DEFAULT '',
  sort_index   INTEGER NOT NULL DEFAULT 100,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category_dir);

-- 点赞表：以「指纹」去重。指纹 = HMAC(IP + UserAgent)，不落地原始 IP
CREATE TABLE IF NOT EXISTS resource_likes (
  resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (resource_id, fingerprint)
);

-- 点赞计数（冗余字段，避免每次 COUNT(*)；由点赞接口在同事务内维护）
CREATE TABLE IF NOT EXISTS resource_stats (
  resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  likes       INTEGER NOT NULL DEFAULT 0
);

-- 财经时事：每日抓取 10 条，按日期分组缓存
CREATE TABLE IF NOT EXISTS news_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_date  TEXT NOT NULL,   -- 缓存日期 YYYY-MM-DD（Asia/Shanghai）
  rank_index   INTEGER NOT NULL, -- 当日第几条，用于稳定排序
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  likes        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (bucket_date, rank_index)
);
CREATE INDEX IF NOT EXISTS idx_news_bucket ON news_items(bucket_date);

-- 通用新闻点赞去重（与资料点赞同理）
CREATE TABLE IF NOT EXISTS news_likes (
  news_id     INTEGER NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (news_id, fingerprint)
);

-- 抓取状态：记录每个信源最近一次成功/失败，用于「失败降级」判断
CREATE TABLE IF NOT EXISTS fetch_state (
  source       TEXT PRIMARY KEY,
  last_ok_at   TEXT,
  last_error   TEXT,
  last_error_at TEXT
);

-- 站点配置：与前端 site_settings 同构，但**敏感键不下发访客**
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- 1 = 敏感项，绝不出现在任何对访客开放的响应里
  secret      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 临时权限申请（「栏目与网站管理 · 账号管理」的待审批队列）
--
-- 申请人在登录页填手机号提交，管理员在后台批准。批准后：
--   1. 以**手机号本身**作为账号名创建 viewer 账号，生成 6 位随机口令；
--   2. 往 notifications 写一条待发送通知（内容为约定的短信文案）。
-- 刻意保留 ip / fingerprint：便于事后判断是否为同一来源的批量提交。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  org         TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  ip          TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  handled_at  TEXT,
  handled_by  TEXT,
  -- 批准后指向 accounts.id，便于从申请跳到账号
  account_id  INTEGER,
  handle_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_phone ON access_requests(phone);

-- ---------------------------------------------------------------------------
-- 通知发件箱
--
-- 站点没有短信网关（零第三方依赖是硬约束），因此「发短信」这一步实现为
-- **写一条待发送记录**：内容完全按约定文案渲染好，管理员在后台可一键复制、
-- 也可以标为已发送。将来挂上真实通道（短信网关 / 邮件中继）时，
-- 只需实现一个投递器读这张表，业务代码不动。
--
-- 这样处理而不是假装「已经发了」：站内必须能区分「已生成」与「已送达」，
-- 否则申请人收不到口令时无人知道断在哪一环。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 投递通道：outbox（默认，仅落库）/ sms / email
  channel    TEXT NOT NULL DEFAULT 'outbox',
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'sent', 'failed')),
  -- 关联业务对象：如 ('access_request', 12)
  ref_type   TEXT NOT NULL DEFAULT '',
  ref_id     INTEGER,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  error      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 站点浏览量
--
-- 粒度是「天 × 路径 × 指纹」，主键天然去重 —— 同一访客反复刷新同一页面
-- 当天只计一次「独立访客」，但 hits 仍能反映热度：hits 由 COUNT(*) 得出，
-- 去重口径由 COUNT(DISTINCT fingerprint) 得出，两个口径都保留。
--
-- 为什么不存原始请求日志：那张表按天无条件增长且绝大多数行永不被查询；
-- 按天聚合后行数被「路径数 × 访客数」封顶，长期运行也不失控。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_view_events (
  day         TEXT NOT NULL,   -- YYYY-MM-DD（Asia/Shanghai）
  path        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (day, path, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_view_events(day);
`;

/**
 * 幂等的列补齐。
 *
 * `CREATE TABLE IF NOT EXISTS` **不会**给已存在的表加新列 ——
 * 老库跑新代码时，新列会静默缺失，然后在查询处炸成 "no such column"。
 * 因此每个新增列都要在这里登记一次。
 *
 * 注意：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持非恒定默认值，
 * 所以这里只加允许为空的列或带常量默认值的列。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureColumns(db) {
  const additions = [
    // resources.display_category：展示类目（电子书籍/数据/研报/课程资源）
    ['resources', 'display_category', "TEXT NOT NULL DEFAULT '研报'"],
    // 以下是「社团成员产出」需要的作品属性。
    // 资料库里的文件本来没有作者概念，但作品卡片与详情页要展示作者、简介与截图，
    // 因此给同一张表补上这几个可选列 —— 非产出条目留空即可，不影响资料列表。
    ['resources', 'author', "TEXT NOT NULL DEFAULT ''"],
    ['resources', 'author_title', "TEXT NOT NULL DEFAULT ''"],
    ['resources', 'author_note', "TEXT NOT NULL DEFAULT ''"],
    ['resources', 'summary', "TEXT NOT NULL DEFAULT ''"],
    // 截图列表：JSON 数组字符串，元素为素材目录内的相对路径或外链
    ['resources', 'screenshots', "TEXT NOT NULL DEFAULT '[]'"],
    // 标签：逗号分隔（与文章表的 tags 口径一致）
    ['resources', 'tags', "TEXT NOT NULL DEFAULT ''"],
    // 部门：社团成员产出页面的**纵向筛选**维度（研发部 / 培训部 / 宣传中心）。
    //
    // ⚠️ 它不是展示类目。展示类目 `display_category` 决定一条记录属于
    // 「资料与数据」还是「社团成员产出」两个模块（模块隔离的依据）；
    // 部门只在**已确定属于产出模块**的记录内部再切一刀。
    // 两者混用会让模块隔离失效 —— 详见 categorize.js 的 PRODUCTION_DEPARTMENTS 注释。
    //
    // 允许空串：未标部门的作品仍出现在「全部」下，只是不进任何部门标签。
    // 因此这里**不能**加 CHECK 约束限制取值 —— 约束会把未来的新部门挡在门外，
    // 而部门构成是会随协会组织架构调整的。
    ['resources', 'department', "TEXT NOT NULL DEFAULT ''"],

    // ---- accounts：账号来源与手机号 ----
    //
    // 需求是「批准申请后以手机号作为账号」。得能区分一个 viewer 账号是
    // 人工新建的、还是从申请批准来的，否则账号列表里会分不清谁该收到通知。
    // 取值：seed（种子）/ manual（后台新建）/ application（申请批准）
    ['accounts', 'source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['accounts', 'phone', "TEXT NOT NULL DEFAULT ''"],
    // 累计延长次数与重置次数：后台列表要显示「已延长 N 次」这类信息，
    // 也算一条轻量的审计痕迹（谁在什么时候动过这个账号的权限）
    ['accounts', 'extended_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['accounts', 'reset_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [table, column, decl] of additions) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some((c) => String(c.name) === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
}

/**
 * 建在「补列之后」的索引。
 *
 * 顺序很关键：`display_category` 索引若写进 SCHEMA 常量，就会在
 * `ensureColumns` 补列之前执行 —— 老库此时还没有这一列，
 * `CREATE INDEX` 直接抛 `no such column: display_category`，
 * 导致整个 `openDatabase` 失败、进程根本起不来。实测踩过一次。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureIndexes(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_resources_display_category ON resources(display_category)');
}

/**
 * 打开数据库并确保表结构就绪。
 * @param {string} dbPath SQLite 文件路径，`:memory:` 表示内存库（测试用）
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // 建表之后补列：老库升级路径
  ensureColumns(db);
  // 补列之后才能建依赖新列的索引
  ensureIndexes(db);
  return db;
}

/**
 * 把 `node:sqlite` 返回的 null-prototype 行转成普通对象，
 * 便于 JSON 序列化与 `Object.keys` 等常规操作。
 * @template T
 * @param {T} row
 * @returns {T | undefined}
 */
export function plain(row) {
  return row ? { ...row } : row;
}

/** 批量转换查询结果 */
export function plainAll(rows) {
  return rows.map((r) => ({ ...r }));
}
