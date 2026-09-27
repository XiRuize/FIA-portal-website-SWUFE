# 西南财经大学金融投资协会 · 自建轻量后端

零运行时第三方依赖的 Node.js 后端，为协会官网提供账号鉴权、资料管理、财经时事与真实行情接口。

**为什么自建而不是挂靠平台**：需求里的账号体系是全局基座（资料权限、管理入口都依赖它），
放在第三方平台上「能不能真正隔离」不可控，且平台授权有不确定性。
自建后整套服务只有一个进程 + 一个 SQLite 文件，既能跑在协会自己的机器上，
也能原样搬到阿里云/学校服务器——不锁定任何供应商。

---

## 1. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22.5.0** | 依赖内置 `node:sqlite`，低于此版本无法启动 |
| 数据库 | 无需安装 | 用 Node 自带的 SQLite，落地为单个 `.db` 文件 |
| 第三方依赖 | **无** | `package.json` 的 `dependencies` 是空对象 |

> `node:sqlite` 目前是 Node 的实验特性，启动时会打印一条 `ExperimentalWarning`。
> 这不影响功能，只是提示 API 仍可能变化。介意的话可用 `--no-warnings` 静音。

---

## 2. 快速开始（三步）

```bash
cd server

# 1) 初始化：播种初始账号 + 扫描素材目录入库
node scripts/seed.mjs          # 生成管理账号与临时浏览账号
node scripts/scan-resources.mjs # 把 资料分享模块素材/ 登记进库

# 2) 自检：确认环境、数据、接口全部就绪
npm run verify

# 3) 启动
npm start
```

服务默认监听 `http://127.0.0.1:8787`。前端开发服务器（Vite）通过该地址访问接口。

### 可用的 npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | 启动并监听文件变化自动重启 |
| `npm test` | 跑单元测试 + HTTP 集成测试（隔离临时库，不碰真实数据） |
| `npm run verify` | **一键自检**：真实库 + 真实素材 + 真实起服务，打印通过/失败清单 |
| `npm run seed` | 播种账号（幂等，已存在则跳过） |
| `npm run scan:resources` | 扫描素材目录并入库（幂等） |
| `npm run setup` | 等价于 seed + scan，首次部署用 |

---

## 3. 默认账号与首次修改

`npm run seed` 会创建两个账号（口令在播种时打印一次，并同时写入 `server/.env` 供本地联调）：

| 角色 | 用户名 | 默认口令 | 权限 |
| --- | --- | --- | --- |
| 管理权限 | `<已清除>` | `<已清除>` | 进入 `/admin`、`/productions`，管理账号、查看受限资料 |
| 临时浏览 | `guest` | `<已清除>` | 仅浏览公开资料；到期自动失效 |

> `<已清除>` / `<已清除>` 是**演示口径**（公开口令），目的是让评审者「拿到就能进」。
> 它 7 位的长度低于 `MIN_PASSWORD_LENGTH = 8`，因此走的是 `src/lib/password.js` 里的
> `DEMO_PASSWORDS` **逐条白名单**，而不是下调全局下限 —— `1234567`、`password`
> 之类的 7 位口令仍会被拒绝。撤销豁免只需删掉那一行。
>
> **部署到公网前必须改口令**：登录后在 `/admin` 页面修改，或直接编辑 `server/.env` 中的种子口令后重新播种。
> `.env` 已被 `.gitignore` 排除，不要提交到仓库。

---

## 4. 配置项（`server/.env`）

所有配置都有合理默认值，`.env` 不存在也能跑。真实环境变量优先级高于 `.env`。

```ini
# 服务
PORT=8787
HOST=127.0.0.1                 # 对外提供服务时改为 0.0.0.0

# 路径（相对路径的解析基准见下方说明）
DB_PATH=./data/fia.db          # 相对 server/
MATERIALS_DIR=../资料分享模块素材  # 相对 server/

# 会话
COOKIE_NAME=fia_session
SESSION_TTL_HOURS_ADMIN=168    # 管理账号 7 天
SESSION_TTL_HOURS_VIEWER=24    # 临时账号 1 天

# 登录防爆破
LOGIN_MAX_FAILS=5              # 连续失败次数上限
LOGIN_WINDOW_MS=600000         # 计数窗口 10 分钟
LOGIN_LOCK_MS=900000           # 锁定 15 分钟

# 跨域（前端开发服务器地址，逗号分隔）
CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173

# 新闻与播种
NEWS_REFRESH_MS=86400000       # 每日刷新一次
NEWS_KEEP_DAYS=7               # 缓存保留 7 天
SEED_VIEWER_DAYS=30            # 新建临时账号的默认有效期
```

> ⚠️ **路径解析的坑**：`MATERIALS_DIR` 的相对基准是 `server/` 而不是项目根，
> 所以默认值里的 `../` 正好跳出 `server/`。这是刻意设计，改基准会导致扫描不到文件。

---

## 5. 接口一览

统一响应格式：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。

### 健康检查

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/health` | 公开 |

### 账号与会话

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 公开 | 登录，成功下发 httpOnly Cookie |
| POST | `/api/auth/logout` | 公开 | 登出并作废会话 |
| GET | `/api/auth/me` | 公开 | 返回当前身份（未登录返回 `authenticated: false`，**不报错**） |
| GET | `/api/auth/guard` | 公开 | 轻量权限探测，前端路由守卫用 |
| POST | `/api/auth/password` | 需登录 | 修改自己的口令 |
| GET | `/api/admin/accounts` | **管理** | 账号列表 |
| POST | `/api/admin/accounts` | **管理** | 新建账号（临时账号必须带到期时间） |
| DELETE | `/api/admin/accounts/:id` | **管理** | 吊销账号（立即失效并清除其全部会话） |

### 资料与数据

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/resources` | 公开 | 列表。**受限分类对匿名访客默认不可见**（见下方安全说明）。支持 `displayCategory` 按展示类目筛选 |
| GET | `/api/resources/categories` | 公开 | 分类及计数（同样已做权限过滤） |
| GET | `/api/resources/:id` | 按条目 | 详情 |
| GET | `/api/resources/:id/preview` | 按条目 | 在线预览，`Content-Disposition: inline`，支持 Range |
| GET | `/api/resources/:id/download` | 按条目 | 下载，`Content-Disposition: attachment` |
| POST/DELETE | `/api/resources/:id/like` | 按条目 | 点赞 / 取消（按客户端指纹去重，幂等）。**受限条目同样需要会话** |

#### 两套分类：磁盘目录 vs 展示类目

前台「资料与数据」只显示**五个展示类目**：`全部` / `电子书籍` / `数据` / `研报` / `课程资源`。

| 概念 | 字段 | 用途 | 谁在看 |
| --- | --- | --- | --- |
| 磁盘目录 | `category_dir` | 文件在 `资料分享模块素材/` 下的真实目录名 | 资料整理者 |
| 展示类目 | `display_category` | 按**文件形态**归入四类之一 | 前台读者 |

两者**刻意解耦**：一个 `.epub` 即使放在 `研发部内部资料/` 下，对读者也属于「电子书籍」。
归类规则见 `src/lib/categorize.js`，按顺序匹配：扩展名 → 体裁关键词 → 兜底为「研报」。

**公司 logo 不进资料库**：`资料分享模块素材/logo/` 是首页展示素材，扫描时仍会入库，
但 `isLibraryItem()` 会把它们挡在前台之外 —— 传 `includeNonLibrary=1` 才可见（仅调试用）。

### 财经时事

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/news/daily` | 公开 | 当日条目（含标题与原文链接）。`?date=YYYY-MM-DD` 回看归档；`?force=1` 强制重抓 |
| GET | `/api/news/dates` | 公开 | 保留窗口内可回看的日期清单（供前端日期条渲染） |
| GET | `/api/news/status` | 公开 | 信源健康状态，排查用 |
| POST/DELETE | `/api/news/:id/like` | 公开 | 点赞 / 取消 |

#### 信源链与三层闸门

按「**与金融市场的相关性**」排序，前一个失败自动降级到下一个：

| 信源 | 端点 | 内容性质 |
| --- | --- | --- |
| 东方财富·财经导读（主） | `getNewsByColumns`，347/353/366/356 四栏并发 | 股市行情、A股策略、全球市场、能源商品 |
| 东方财富·股市快讯（次） | `getFastNewsList?fastColumn=104` | 机构调研、港股收盘、新股发行、回购减持 |
| 新浪财经·宏观（备） | `feed.mix.sina.com.cn/api/roll/get?lid=1687` | 宏观金融（**已停更，仅作最后兜底**） |

抓到的内容要过三道闸门，任一不过即整源拒用：

1. **相关性闸门**：`isMarketRelevant()` 命中率 < 30% 判该源已退化为综合资讯。
   聚合平台（东方财富/新浪财经）**不构成市场向背书** —— 它们只做转载。
2. **时效闸门**：`assertFresh()` 要求源内最新一条在 7 天内，否则判为停更。
   （内容质量与新鲜度是正交的：`lid=1687` 条条相关却停更 138 天。）
3. **栏目配平**：多栏目合并时按名额上限（4/3/2/2）轮流取稿。
   不配平的话，发稿快的能源栏会独占 8/10，首页变成「油市专版」。

**信源可靠性需逐栏实测，不能看名字**。已实测踩坑的三个源：
`lid=1686`（标称财经，实为时政社会）、`column=345`（标称财经导读，实为要闻混编）、
`fastColumn=102`（全品类播报，30 条仅 2 条相关）。详见 `src/lib/news.js` 顶部注释。

#### 归档与回溯

- 按 **Asia/Shanghai 自然日** 分桶写入 `news_items`，每天至多抓一次。
- 保留 `NEWS_KEEP_DAYS` 天（默认 7），前端按日期条点击切换。
- `availableDates()` 会自行套用保留窗口 —— 不能只依赖 `cleanup()`，
  因为它只在抓取收尾时执行，服务停跑时过期日期会泄漏到日期条上。
- 日期参数做**形状 + 真实日历**双重校验：`2026-13-45`、`2026-02-31` 均返回 400。

### 行情

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/stock/quote?code=600702` | 公开 | 单只实时快照 |
| GET | `/api/stock/multi?codes=600702,000001` | 公开 | 批量快照 |
| GET | `/api/stock/kline?code=600702&limit=120` | 公开 | 日 K 线 |
| GET | `/api/stock/status` | 公开 | 数据源可达性 + 本次实际使用的源 |

### 站点设置

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/settings` | 公开 | 站点配置（**不含任何口令类字段**） |
| PUT | `/api/settings` | **管理** | 更新站点配置 |

---

## 6. 安全设计（交付时值得核对的几条）

1. **口令只存 scrypt 哈希**，接口在任何情况下都不回传哈希。
2. **会话 token 存 SHA-256 哈希**：即使数据库泄露，也无法拿库里的值直接冒充登录。
3. **受限资料默认拒绝**：服务端按会话判定可见级别，而不是信任前端传参。
   匿名访客即使手动加上 `?restricted=1` 也拿不到受限条目——这一条已被自检
   与集成测试双重覆盖。
4. **读与写共用同一道闸门**：受限条目的「列表 / 详情 / 预览 / 下载 / 点赞 / 取消点赞」
   全部走同一个准入判定。
   > 这里踩过一次真实的坑：早期只有读接口校验了 `access_level`，
   > `POST|DELETE /:id/like` 仅检查 id 合法性就落库，于是未登录访客
   > 虽然读不到受限条目，却能给它们点赞，并从 `200` 响应体里读到
   > 该条目的名称与体积——等价于绕过列表过滤拿到元数据。
   > 现由 `test/api.test.js` 的三条回归用例 + `verify.mjs` 的两项自检长期看守。
5. **统计口径同步过滤**：分类计数也会剔除受限条目，避免从「数量变化」反推内部资料规模。
6. **登录防爆破**：按「账号 + IP」计数，超限锁定；失败响应不区分「账号不存在」与「口令错误」。
7. **临时账号到期即作废**：返回 `403` + `ACCOUNT_EXPIRED`（而非 `401`），
   让前端能提示「请联系协会负责人重新开通」，而不是误导用户以为口令错了。
8. **Cookie 为 httpOnly + SameSite=Lax**。生产环境走 HTTPS 时把 `cookieSecure` 置为 true。

---

## 7. 手动验证步骤（curl，逐条可复现）

> Windows 上 curl 可能被系统代理拦截，**所有命令都要加 `--noproxy '*'`**，
> 否则会得到莫名其妙的连接失败。

```bash
BASE=http://127.0.0.1:8787

# 1. 服务活着
curl -s --noproxy '*' $BASE/api/health

# 2. 匿名身份应为访客（返回 200，而不是 401）
curl -s --noproxy '*' $BASE/api/auth/me

# 3. 错误的登录必须被拒，且不下发 cookie
#    ⚠️ 用一次性账号名，别拿真实账号连打 —— 失败计数按「账号 + IP」两个维度累加，
#       打满 5 次会把**本机 IP** 锁 15 分钟，之后连正确口令也会被挡在 429
curl -s --noproxy '*' -i -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"__probe_once","password":"wrong"}' | head -20

# 4. 匿名读受限资料应拿不到（把 <已清除> 换成实际账号）
#    注意观察返回条数与是否存在「研发部内部资料」
curl -s --noproxy '*' "$BASE/api/resources?pageSize=500" | head -c 400
curl -s --noproxy '*' "$BASE/api/resources?pageSize=500&restricted=1" | head -c 400

# 5. 管理接口匿名应 401
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' $BASE/api/admin/accounts

# 6. 登录并保存 cookie，然后确认身份与权限
curl -s --noproxy '*' -c /tmp/fia.txt -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<已清除>","password":"<已清除>"}'
curl -s --noproxy '*' -b /tmp/fia.txt $BASE/api/auth/me

# 7. 带 cookie 访问管理接口应 200
curl -s --noproxy '*' -b /tmp/fia.txt -o /dev/null -w '%{http_code}\n' $BASE/api/admin/accounts

# 8. 登出后会话立即失效（应回到 401）
curl -s --noproxy '*' -b /tmp/fia.txt -c /tmp/fia.txt -X POST $BASE/api/auth/logout
curl -s --noproxy '*' -b /tmp/fia.txt -o /dev/null -w '%{http_code}\n' $BASE/api/admin/accounts

# 9. 行情返回真实数据（关注 source 字段与时间戳）
curl -s --noproxy '*' "$BASE/api/stock/quote?code=600702"

# 10. 数据源可达性
curl -s --noproxy '*' $BASE/api/stock/status

# 11. 当日财经时事（10 条，含原文链接）
curl -s --noproxy '*' "$BASE/api/news/daily?limit=10" | head -c 600

# 12. 受限条目的写操作也必须被拦（回归项：曾经只拦了读）
#     先取一个受限条目的 id
SECRET_ID=$(curl -s --noproxy '*' -b /tmp/fia.txt \
  "$BASE/api/resources?pageSize=500" \
  | grep -o '"id":[0-9]*,"relPath":"[^"]*"' | head -1 | grep -o '[0-9]*' | head -1)
curl -s --noproxy '*' -o /dev/null -w '匿名点赞受限条目 -> %{http_code}（应为 401）\n' \
  -X POST "$BASE/api/resources/$SECRET_ID/like"
# 拒绝响应体里不应出现条目名称
curl -s --noproxy '*' -X POST "$BASE/api/resources/$SECRET_ID/like"

# 13. 公开条目的点赞必须照常放行（闸门不能误伤）
curl -s --noproxy '*' -o /dev/null -w '匿名点赞公开条目 -> %{http_code}（应为 200）\n' \
  -X POST "$BASE/api/resources/1/like"
curl -s --noproxy '*' -X DELETE "$BASE/api/resources/1/like" >/dev/null
```

想要一步到位，直接跑 `npm run verify`：它会自动执行上述全部检查并打印通过/失败清单。

---

## 8. 数据源说明

### 行情：多源适配器

优先级：**free-stockdb（主源）→ 腾讯行情（回退源）**。

- 主源 [free-stockdb](https://github.com/hello245m/free-stockdb) 是本地 HTTP 服务，
  默认地址 `http://127.0.0.1:7899`。它需要**单独部署并常驻运行**，本仓库不包含它。
- 主源不可达时自动回退到腾讯公开行情接口，响应里会带 `source: "tencent"` 与
  `fallbackReason`，**绝不会静默返回演示数据**——来源始终可辨识。
- 想启用主源：按该项目文档部署后，确认 `http://127.0.0.1:7899/?cmd=get&t=日k:600702:20260623`
  能返回数据即可，无需改本仓库配置。

> ⚠️ **浏览器直连的限制**：前台页面若直接从 `https` 页面请求
> `http://127.0.0.1:7899`，会被浏览器的混合内容（Mixed Content）策略拦截。
> 所以行情请求统一走本后端代理，前端只跟后端同源通信。这也是自建后端的一个实际收益。

### 财经时事

双通道，先直连后兜底：

- **浏览器直连公开接口**（起步方案）：直接取公开聚合接口，无需密钥。
- **平台 HTTP 抓取工作流**（备份方案）：直连失败时切换到抓取工作流。

每日 10 条，按日期分桶缓存（`bucket_date`），保留 7 天。条目含标题与原文链接，
点击在新窗口打开原文。首次调用 `/api/news/daily` 时触发抓取，之后走缓存。

---

## 9. 部署

### 本机 / 内网（学校服务器）

```bash
cd server
npm run setup && npm start
```

### 长期运行

用 systemd 或 pm2 托管；SQLite 是单文件，备份即拷贝 `server/data/fia.db`。

### 依赖提示

后端**不依赖任何第三方包**，所以不需要 `npm install`，也不存在依赖漏洞面。
这意味着部署时不会遇到「服务器上没有 pnpm/npm 源」这类问题。

### 上线前检查清单

- [ ] 修改 `<已清除>` 与 `guest` 的默认口令（`<已清除>` 是演示口令，等价于公开）
- [ ] 视情况移除 `src/lib/password.js` 里的 `DEMO_PASSWORDS` 豁免
- [ ] `HOST` 按需改为 `0.0.0.0`
- [ ] 走 HTTPS 时确认 Cookie 的 `secure` 已开启
- [ ] `CORS_ORIGINS` 收紧为实际域名（不要留 `*`）
- [ ] `npm test` 与 `npm run verify` 均通过
- [ ] 确认 `研发部内部资料` 在匿名视角下不可见

---

## 10. 目录结构

```
server/
├── src/
│   ├── index.js            # 启动入口：读配置、建库、起服务、优雅退出
│   ├── app.js              # 路由表与请求分发
│   ├── lib/
│   │   ├── db.js           # SQLite 建表与迁移
│   │   ├── env.js          # .env 解析与配置构建
│   │   ├── http.js         # 响应封装、Cookie、CORS
│   │   ├── password.js     # scrypt 哈希与口令强度校验
│   │   ├── fingerprint.js  # 客户端指纹（点赞去重）
│   │   ├── accounts.js     # 账号与会话（鉴权核心）
│   │   ├── resources.js    # 资料列表/预览/下载/点赞
│   │   ├── scan.js         # 素材目录扫描入库（CLI 与测试共用同一份逻辑）
│   │   ├── news.js         # 财经时事抓取与缓存
│   │   ├── stock.js        # 行情多源适配器
│   │   └── symbols.js      # 股票代码识别与市场判断
│   └── routes/             # 各模块的 HTTP 处理函数
├── scripts/
│   ├── seed.mjs            # 播种账号
│   ├── scan-resources.mjs  # 扫描素材入库（CLI）
│   └── verify.mjs          # 一键自检
├── test/
│   ├── unit.test.js        # 纯函数单元测试
│   └── api.test.js         # HTTP 集成测试（含权限隔离断言）
└── data/                   # SQLite 数据文件（运行时生成）
```

---

## 11. 测试与自检

```bash
npm test          # 42 项：单元 + HTTP 集成，用临时库，不碰真实数据
npm run verify    # 28 项：真实库 + 真实素材 + 真实服务
```

`npm test` 的价值在于**回归**：它用隔离的临时数据库起一个真实 HTTP 服务，
覆盖登录失败/成功、伪造 token、过期账号、权限隔离、受限资料泄露、点赞幂等、
错误处理等路径。其中「匿名访客拿不到受限资料」这条断言，在开发过程中真实拦下过
一个数据泄露缺陷（受限条目本可被匿名访客读到），后续修复即由该测试守住。

`npm run verify` 的价值在于**体检**：回答「这台机器现在能不能跑」——
数据在不在、素材扫没扫、端口通不通、行情源可达否。它只读，不会改素材文件。
