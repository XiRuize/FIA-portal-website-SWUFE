# 验证手册（前端 + 自建轻量后端）

本文件回答一个问题：**怎么证明这套东西真的能跑、跑的是真实数据、权限真的被隔离了。**

设计原则是把「可验证」做成默认属性，而不是靠人工点页面确认：

- 后端自带 **160 条测试**（单元 + 集成）与 **56 项一键自检**；
- 前端有 **类型检查 + lint 门禁**，可重复执行；
- 关键安全边界（受限资料、管理接口、写操作闸门）都有**回归用例长期看守**，
  而不是只在交付时人工验一次。

---

## 0. 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22.5.0 | 后端用了内置的 `node:sqlite`，低于此版本没有该模块 |
| pnpm | >= 8 | 前端包管理器（`AGENTS.md` 硬约束，不要换成 npm/yarn） |

后端**零运行时第三方依赖**（`server/package.json` 的 `dependencies` 是空的），
因此不需要在 `server/` 下安装任何东西，克隆下来就能起。

---

## 1. 最短验证路径（三步）

```bash
# 1) 初始化：播种初始账号 + 扫描素材目录入库（幂等，可重复执行）
cd server
npm run setup

# 2) 自检：环境 / 数据库 / 扫描幂等性 / HTTP 接口，共 56 项
npm run verify

# 3) 跑测试：单元 + HTTP 集成，共 160 条
npm test
```

三步全绿即说明**后端可独立运行、数据真实、权限生效**。

然后开两个终端：

```bash
# 终端 A —— 后端
cd server && npm start          # 监听 127.0.0.1:8787

# 终端 B —— 前端
pnpm dev                        # 监听 5173，/api 已代理到 8787
```

浏览器打开 <http://localhost:5173>。

> **为什么要走代理**：前端通过 Vite 的 `/api` 代理访问后端，保证请求同源。
> 这样 httpOnly 的会话 Cookie 才会被浏览器接受，也不会撞上 Mixed Content。
> 代理配置见 `vite.config.ts` 的 `server.proxy`。

---

## 2. 前端门禁

```bash
pnpm check     # = pnpm type-check + pnpm lint
pnpm build     # 生产构建，确认没有构建期错误
```

当前状态：`tsc` 0 错误、`eslint` 0 问题、`vite build` 通过（1827 modules）。

---

## 3. 权限边界：三类身份的实测结果

这是整个系统最需要被证明的部分。用下面命令可完整复现：

```bash
BASE=http://127.0.0.1:8787

# --- 匿名 ---
curl -s --noproxy '*' $BASE/api/auth/me                    # authenticated=false, role=guest
curl -s --noproxy '*' $BASE/api/admin/accounts -o /dev/null -w '%{http_code}\n'   # 401
curl -s --noproxy '*' "$BASE/api/resources?pageSize=500"   # 26 条 / 0 条受限

# --- 临时浏览账号（viewer）---
curl -s --noproxy '*' -c /tmp/v.txt -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"guest","password":"<已清除>"}'
curl -s --noproxy '*' -b /tmp/v.txt "$BASE/api/resources?pageSize=500"            # 60 条（含受限）
curl -s --noproxy '*' -b /tmp/v.txt -o /dev/null -w '%{http_code}\n' $BASE/api/admin/accounts   # 403
curl -s --noproxy '*' -b /tmp/v.txt -X PUT $BASE/api/settings \
  -H 'Content-Type: application/json' -d '{"settings":{}}' -o /dev/null -w '%{http_code}\n'      # 403

# --- 管理账号（admin）---
curl -s --noproxy '*' -c /tmp/a.txt -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<已清除>","password":"<已清除>"}'
curl -s --noproxy '*' -b /tmp/a.txt -o /dev/null -w '%{http_code}\n' $BASE/api/admin/accounts   # 200
curl -s --noproxy '*' -b /tmp/a.txt "$BASE/api/resources?pageSize=500"            # 60 条（受限 34）
```

预期结果汇总：

| 检查项 | 匿名 | 临时浏览 | 管理 |
| --- | --- | --- | --- |
| `/api/auth/me` | 200（guest） | 200（viewer） | 200（admin） |
| 资料可见条数 | **26**（受限 0） | **60**（受限 34） | **60**（受限 34） |
| `/api/admin/accounts` | 401 | **403** | 200 |
| `PUT /api/settings` | 401 | **403** | 200 |
| 受限条目 `preview` / `download` | 401 | 200 | 200 |
| 受限条目 `like` | **401** | 200 | 200 |
| 公开条目 `like` | 200 | 200 | 200 |

> `403` 与 `401` 的区别是刻意的：`401` 表示「你没登录」，`403` 表示
> 「你登录了但权限不够」。前端据此给出不同文案，避免把「权限不足」
> 显示成「口令错误」。

### 3.1 「社团成员产出」的门禁链路（需求：入口要看得见，权限判定发生在点击之后）

这里的做法**不是把入口藏起来**，而是让访客看得见、点得动，再在登录页说清申请方式。
两件事要分清：

| 做法 | 访客体验 | 适用场景 |
| --- | --- | --- |
| 隐藏入口（`NAV_ITEMS` 带 `requires`） | 看不到，无从知道功能存在、该找谁申请 | 纯后台入口，如「内容管理」 |
| **门禁入口（当前做法）** | 看得到 → 点击 → 落到登录页读到申请邮箱 | 「社团成员产出」 |

复现（前端行为，需浏览器或读构建产物）：

```bash
# 1) 导航项已不带权限门槛 —— 任何人都能渲染出这一项
grep -o '{to:"/productions",label:"社团成员产出"}' dist/assets/index-*.js
#    期望：命中，且该项**不含** requires 字段

# 2) 登录页与守卫页共用同一份提示文案
grep -o '社团成员产出仅限有权限账号进行浏览，可发送邮箱至1458164460@qq.com申请权限' dist/assets/index-*.js
grep -o '1458164460@qq.com' dist/assets/index-*.js
```

后端准入链路（这是安全边界，前端那层只是体验）：

```bash
# 用演示账号登录 → 会话 cookie → 受限数据真的变多
curl -s --noproxy '*' -c /tmp/a.txt -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"<已清除>","password":"<已清除>"}'
curl -s --noproxy '*' -b /tmp/a.txt $BASE/api/auth/me | grep -o '"capabilities":\[[^]]*\]'
#    期望含 canViewRestricted（进 /productions 所需）与 canManageContent（进 /admin 所需）
```

`npm run verify` 中对应两条检查：

```
[通过] 演示账号 <已清除> 存在且为管理权限（口令可校验）
[通过] <已清除> / <已清除> 可登录并解锁「社团成员产出」（受限数据可见）
       HTTP 200 · 登录视角 60 条（受限 34 条）> 访客 26 条
```

> ⚠️ `<已清除>` 是**公开口令**，仅用于演示与评审。它的 7 位长度低于
> `MIN_PASSWORD_LENGTH = 8`，因此在 `password.js` 里走的是 `DEMO_PASSWORDS`
> **逐条白名单**，而不是下调全局下限 —— 7 位的 `1234567`、`password` 等仍被拒绝。
> 正式投放前应改密或吊销该账号。

---

## 4. 已修复的安全缺陷（附回归看守）

### 4.1 受限条目的写操作曾缺失权限闸门

**现象**：匿名访客读不到受限条目（列表、详情、预览、下载都正确返回 401），
但 `POST /api/resources/:id/like` 返回 **200**。

**影响**：不只是点赞数被污染——`200` 的响应体里带着该条目的
`name` / `sizeText` / `category`，等价于**绕过列表过滤拿到了受限资料的元数据**。

**根因**：`detail` / `preview` / `download` 三条读路径都校验了
`access_level === 'member'`，而 `like` / `unlike` 只校验了 id 合法性就落库。

**修复**：抽出 `requireItemAccess(req, res, id)`，让读写共用同一道闸门
（`server/src/routes/resources.js`）。

**看守**：
- `server/test/api.test.js` 新增 3 条回归用例，其中一条显式断言
  「拒绝响应体不得包含受限条目名称」；
- `server/scripts/verify.mjs` 新增 2 项自检。

复现验证：

```bash
curl -s --noproxy '*' -X POST $BASE/api/resources/46/like          # 应为 401
curl -s --noproxy '*' -X POST $BASE/api/resources/46/like | head -c 200
# {"ok":false,"error":{"code":"UNAUTHENTICATED","message":"该内容仅对已登录成员（含临时浏览账号）开放"}}

curl -s --noproxy '*' -X POST $BASE/api/resources/3/like -o /dev/null -w '%{http_code}\n'   # 公开条目应为 200
```

### 4.2 素材文件 MIME 与扩展名不一致

**现象**：`腾讯.png` 实际是 JPEG 文件（魔数 `ff d8 ff e0`），
按扩展名会下发 `image/png`，部分浏览器会拒绝渲染。

**修复**：`openFile()` 读取文件头 16 字节做魔数嗅探，覆盖
JPEG / PNG / GIF / WEBP / PDF（`server/src/lib/resources.js` 的 `sniffMime`）。
嗅探不出结果时才回落到扩展名。

**看守**：`test/unit.test.js` 有 4 条嗅探用例（含 WEBP 必须读到第 12 字节才能确认）。

---

## 5. 真实数据源的验证

### 行情（需求 5）

```bash
curl -s --noproxy '*' "$BASE/api/stock/quote?code=600702"
curl -s --noproxy '*' "$BASE/api/stock/multi?codes=600702,600519,000001,000858,601318,300750"
curl -s --noproxy '*' "$BASE/api/stock/kline?code=600519&limit=120"
curl -s --noproxy '*' "$BASE/api/stock/status"
```

实测（2026-09-26）：股票池 **6/6** 全部返回真实报价，K 线各 120 根，
区间 2026-04-03 → 2026-09-24，`source=tencent`。

数据源策略是**多源适配器**，不是单点依赖：

```
命中 30s 缓存
  → 自建后端（后端内部：free-stockdb 优先 → 腾讯行情回退）
    → 浏览器直连 free-stockdb（仅本地开发有效）
      → 演示数据（**并在界面显式标注**，绝不伪装成真实行情）
```

`/api/stock/status` 会直接告诉你本次走的是哪个源、主源为什么不可达。
当前环境里 free-stockdb 未在 `127.0.0.1:7899` 启动，因此自动回退到腾讯行情，
`fallbackReason` 明确写着「free-stockdb 不可达（fetch failed）」——这是**预期行为**。
想启用主源，把 `FREE_STOCKDB_BASE` 指向实际地址再启动即可。

### 财经时事（需求 4）

```bash
curl -s --noproxy '*' "$BASE/api/news/daily?limit=10"
curl -s --noproxy '*' $BASE/api/news/status
```

实测返回 10 条，日期 2026-09-26，每条都带可打开的原文链接
（新浪财经 / 界面 / 央视等）。抓取失败时会返回**过期缓存并标记 `stale`**，
同时在 `message` 里说明原因，而不是静默返回空列表。

### 资料与数据（需求 2）

素材目录 `资料分享模块素材/` 已被扫描入库。前台**只显示五个展示类目**，
且**公司 logo 不出现在资料库里** —— logo 属于首页「会友去向」的展示素材。

下列数字是**匿名访客**所见（26 条）；登录后可见全部 60 条
（`研发部内部资料` 34 条为受限分类，需登录）：

| 展示类目 | 匿名可见 | 登录后 | 说明 |
| --- | --- | --- | --- |
| 全部 | 26 | 60 | 恒等于下列四类之和 |
| 电子书籍 | 0 | 2 | epub / mobi / azw3 / djvu |
| 数据 | 1 | 2 | xlsx / xls / csv，以及会议纪要类 |
| 研报 | 17 | 40 | 券商研报、带日期的分析稿 |
| 课程资源 | 8 | 16 | 分享稿、培训材料、压缩包 |

```bash
# 五个类目、顺序固定、全部 = 四类之和
curl -s --noproxy '*' "$BASE/api/resources?pageSize=1" \
  | python -c "import sys,json;d=json.load(sys.stdin)['data'];print([c['category']+':'+str(c['count']) for c in d['categories']])"
# ['全部:26', '电子书籍:0', '数据:1', '研报:17', '课程资源:8']

# 按展示类目筛选：返回条目必须条条属于该类（不串档）
curl -s --noproxy '*' "$BASE/api/resources?pageSize=500&displayCategory=研报" \
  | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(len(d['items']), set(i['displayCategory'] for i in d['items']))"
# 17 {'研报'}

# logo 不得出现在资料库（库中记录仍在，只是不对前台暴露）
curl -s --noproxy '*' "$BASE/api/resources?pageSize=500" \
  | python -c "import sys,json;d=json.load(sys.stdin)['data'];print([i['name'] for i in d['items'] if i['category']=='logo'])"
# []
```

> **磁盘目录 ≠ 展示类目**：前者是文件在素材目录下的真实位置（给整理者看），
> 后者按**文件形态**归类（给读者看）。一个 `.epub` 即使放在 `研发部内部资料/` 下，
> 对读者也属于「电子书籍」。

```bash
# 中文文件名的下载头必须走 RFC 5987
curl -s --noproxy '*' -D - -o /dev/null "$BASE/api/resources/3/download" | grep -i content-disposition
# content-disposition: attachment; filename="______.jpeg"; filename*=UTF-8''%E4%B8%AD%E5%9B%BD%E5%86%9C%E4%B8%9A%E9%93%B6%E8%A1%8C.jpeg

# PDF 必须支持断点续传（翻页 / 拖进度条依赖它）
curl -s --noproxy '*' -D - -o /dev/null -H 'Range: bytes=0-1023' "$BASE/api/resources/1/preview" \
  | grep -iE 'HTTP/|content-range|accept-ranges'
# HTTP/1.1 206 Partial Content
# Accept-Ranges: bytes
# Content-Range: bytes 0-1023/4174254
```

### 财经时事：信源与归档（需求 3、4）

信源链按「**与金融市场的相关性**」排序，前一个失败自动降级：

| 信源 | 内容性质 |
| --- | --- |
| 东方财富·财经导读（主） | 股市行情、A股策略、全球市场、能源商品（四栏并发） |
| 东方财富·股市快讯（次） | 机构调研、港股收盘、新股发行、回购减持 |
| 新浪财经·宏观（备） | 宏观金融（**已停更，仅作最后兜底**） |

```bash
# 1) 内容必须与金融市场相关（用后端自己的判定器，避免两套词表漂移）
curl -s --noproxy '*' "$BASE/api/news/daily?limit=50" \
  | python -c "
import sys,json
items=json.load(sys.stdin)['data']['items']
print(len(items),'条；最新',items[0]['publishedAt'],'；来源数',len(set(i['source'] for i in items)))"
# 10 条；最新 2026-09-26T11:00:57.000Z；来源数 6

# 2) 严格时间倒序（相关度只能当次序键，不能打乱时间线）
curl -s --noproxy '*' "$BASE/api/news/daily?limit=50" \
  | python -c "
import sys,json
items=json.load(sys.stdin)['data']['items']
ts=[i['publishedAt'] for i in items]
print('严格倒序' if all(ts[i]<=ts[i-1] for i in range(1,len(ts))) else '顺序错乱')"
# 严格倒序

# 3) 保留一周 + 可回看的日期清单
curl -s --noproxy '*' "$BASE/api/news/dates"
# {"ok":true,"data":{"dates":[{"date":"2026-09-26","count":10}],"keepDays":7}}

# 4) 按日期回看归档（只读缓存，不触发抓取）
curl -s --noproxy '*' "$BASE/api/news/daily?date=2026-09-26" \
  | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['date'],len(d['items']),'条')"

# 5) 非法日期必须 400（形状 + 真实日历双重校验）
for d in 2026-13-45 2026-02-31 2026-9-20 20260920 today; do
  printf '%-12s -> ' "$d"
  curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "$BASE/api/news/daily?date=$d"
done
# 2026-13-45   -> 400
# 2026-02-31   -> 400
# 2026-9-20    -> 400
# 20260920     -> 400
# today        -> 400

# 6) 换信源后排障：force=1 必须真的重抓（否则会误以为改了没生效）
curl -s --noproxy '*' "$BASE/api/news/daily?limit=10&force=1" \
  | python -c "import sys,json;d=json.load(sys.stdin)['data'];print('fromCache',d['fromCache'])"
# fromCache False
```

> **信源可靠性必须逐栏实测，不能看名字。** 已实测踩坑的三个源名字都像财经：
> 新浪 `lid=1686`（实为时政社会）、东方财富 `column=345`（实为要闻混编）、
> 东方财富 `fastColumn=102`（全品类播报，30 条仅 2 条相关）。
> 现行三层闸门：**相关性**（命中率 < 30% 整源拒用）、**时效**（最新一条 > 7 天判停更）、
> **栏目配平**（名额 4/3/2/2 轮转补位，防止快栏目独占首页）。

---

## 6. 前端页面的实测路径

后端接口可用不等于页面对。逐条走一遍：

| 页面 | 地址 | 要确认的事 |
| --- | --- | --- |
| 首页 | `/#/` | 「关于协会」的成立年份为 **2002 年 9 月**（不是 2006）、累计会员 2000+、「会友机构 300+」；「合作单位 / 会友去向」logo 三行双向缓慢流动 |
| 资料与数据 | `/#/resources` | 顶部五个类目按钮 **全部 / 电子书籍 / 数据 / 研报 / 课程资源**（空类目显示「暂无」）；**看不到任何公司 logo**；每行=左侧名称 + 右侧「点赞/预览/下载/分享」；右上角可切换**按时间 / 按点赞**排序；受限条目对访客不出现 |
| 财经时事 | `/#/news` | **先看到行情看板，向下滚动才看到每日要闻**；要闻区顶部有日期条，可点击切换回溯最近 7 天；标题可点开原文（新标签页） |
| 行情看板 | `/#/` 行情条、`/#/productions` 内看板 | 显示真实价格与 K 线；若落到演示数据，界面必须出现来源说明 |
| 登录 | `/#/login` | 错误口令有明确中文提示；临时账号到期提示「请联系协会负责人」；从「社团成员产出」进来的会先在表单**上方**看到申请权限提示；**页面下方有「申请临时权限与账号」入口，展开后含手机号输入框** |
| 栏目与网站管理 | `/#/admin` | 页面标题为「栏目与网站管理」，顶层三个栏目 **数据 / 内容上传与管理 / 账号管理**；未登录 → 「没有权限，请登录管理员账号」并给登录入口；临时账号访问 → 权限不足提示 |
| └ 数据 | `/#/admin` · 数据 | 累计浏览量 / 今日 / 独立访客 / 存活访客账号四张卡片；近 14 日趋势图；**存活访客账号带剩余时长倒计时，过期的用红字显示「已过期」并可一键延长** |
| └ 内容上传与管理 | `/#/admin` · 内容上传与管理 | 左侧二级导航五个标签 **文件上传 / 内容条目 / 历史沿革 / 组织架构 / 站点设置**；文件上传页可选文件并勾选归档目录、展示类目、访问级别，上传后自动入库 |
| └ 账号管理 | `/#/admin` · 账号管理 | 待审批申请显示**明文手机号**；批准后弹出口令回执与短信文案；下方是已运行的临时账号（账号 + 剩余时长 + 一键重置权限 / 延长）；最下是通知发件箱 |
| 社团成员产出 | `/#/productions` | **导航栏对匿名访客可见**（不是隐藏）；点击后落到 `/#/login?next=%2Fproductions`，页面提示「仅限有权限账号浏览 + 申请邮箱」；用 `<已清除>` / `<已清除>` 登录后「继续前往」即可进入浏览页。**引导语下方有部门导航**（全部 / 研发部 / 培训部 / 宣传中心），点击即筛选，状态写进 URL（`?dept=研发部`）可与排序共存（`?dept=研发部&sort=likes`） |

> 路由守卫（`src/components/auth/RequireAuth.tsx`）只负责**展示层准入**。
> 真正的数据隔离在后端按会话判定——绕过守卫也拿不到受限数据，这一点由第 3 节的
> 对照表证明。
>
> 「社团成员产出」的入口刻意**不做隐藏**：隐藏只让访客困惑（功能看不见、也不知道找谁申请），
> 门禁式入口才能把「这是什么 / 为什么进不去 / 怎么申请」三件事一次讲清。

---

## 7. 初始账号

`npm run setup` 会播种两个账号（首次登录后请立即改口令）：

| 用户名 | 角色 | 默认口令 | 权限 |
| --- | --- | --- | --- |
| `<已清除>` | 管理权限 | `<已清除>` | 内容管理、账号管理、受限内容、社团成员产出 |
| `guest` | 临时浏览 | `<已清除>` | 仅受限内容浏览，30 天后到期 |

> `<已清除>` / `<已清除>` 是**演示口令**，为了让评审者「拿到就能进」。它 7 位的长度低于
> `MIN_PASSWORD_LENGTH = 8`，因此在 `src/lib/password.js` 里走的是 `DEMO_PASSWORDS`
> 白名单（逐条列举），**没有**下调全局下限 —— `1234567`、`password` 等 7 位口令仍被拒绝。
> 这个豁免是可撤销的：删掉那一行即恢复全局限定。

口令可在 `server/.env` 里用 `SEED_ADMIN_PASSWORD` / `SEED_VIEWER_PASSWORD` 覆盖。
**部署到公网前必须改掉默认口令**，并在 `.env` 里设置 `SESSION_SECRET`。

---

## 8. 出问题时的排查顺序

1. `npm run verify` 是否全绿？它会自动改用空闲端口，所以「端口被占用」不会误报成后端故障。
2. 前端拿不到数据 → 后端起了吗（`curl $BASE/api/health`）；代理生效了吗
   （`curl http://localhost:5173/api/health` 应返回同一份 JSON）。
3. 登录后仍被挡 → 看 `/api/auth/me` 返回的 `capabilities`，确认账号角色与到期时间。
4. 行情显示演示数据 → 看 `/api/stock/status` 的 `activeSource` 与 `error` 字段。
5. Windows 上 curl 报连接失败 → **加 `--noproxy '*'`**，系统代理会拦截本地回环请求。
