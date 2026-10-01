# 西财金融投资协会官网 — Agent 契约

## Goal

本仓库是**西南财经大学金融投资协会（FIA）官网**，不是通用模板。
按下面这些确定性的规则交付，才能少猜、少返工。

## Command Contract

只用 `pnpm`。

```bash
pnpm dev         # 前端 dev server（http://127.0.0.1:5173）
pnpm build       # 构建生产产物
pnpm type-check  # tsc --noEmit
pnpm lint        # eslint src --ext ts,tsx
pnpm check       # 必过门禁：type-check + lint
```

后端是**零运行时第三方依赖**的独立服务，在 `server/` 目录下单独跑：

```bash
cd server && node src/index.js    # 起后端（默认 127.0.0.1:8787）
cd server && npm test             # 后端测试（node --test）
cd server && npm run verify       # 一键自检
```

⚠️ **改了后端代码必须重启后端进程**，否则「改动不生效」。
前端经 Vite 的 `/api` 代理访问后端以保持同源 Cookie；**后端没起时，
登录、资料库、产出模块会整体失效**。

## Task Entry（每次都照做）

1. 用一句话说清要改哪个页面/模块、达成什么目标。
2. 定位到对应目录（`pages` / `components` / `lib` / `router` / `server/src`）。
3. 先读同类既有实现的写法，跟着它写，不要自创第二套风格。
4. 用 React 函数组件 + hooks 实现。
5. 收尾跑 `pnpm check`；动了后端还要跑 `npm test` 与 `npm run verify`。

## Structure Mapping

| 关注点 | 位置 |
| --- | --- |
| 路由页面 | `src/pages/*.tsx` |
| 站点组件 | `src/components/site/*` |
| 后台组件 | `src/components/admin/*` |
| 鉴权与会话 | `src/lib/auth.tsx`（常量单一出处）+ `src/components/auth/RequireAuth.tsx` |
| 后端 API 客户端 | `src/lib/backendApi.ts` |
| 内容仓库（前台内容） | `src/lib/store.tsx` + `contentApi.ts` + `localDb.ts` |
| 种子内容 | `src/data/seed.ts`（改正文后**必须**递增顶部 `SEED_REV`） |
| 路由注册表 | `src/router/index.tsx` |
| 后端入口 | `server/src/index.js` → `server/src/app.js` 的 `createApp()` |
| 后端路由 | `server/src/routes/*.js` |
| 后端服务层 | `server/src/lib/*.js` |
| 后端测试 | `server/test/*.test.js` |
| 部署资产 | `deploy/`（Nginx / systemd / 脚本 / 上线手册，见 `deploy/README.md`） |

## Deployment

生产环境是**一台境内云服务器 + Nginx + systemd**，不是静态托管
（后端是常驻进程且持有 SQLite，Vercel/Netlify/GitHub Pages 跑不了）。

- 首次部署、日常发版、故障排查：**照 `deploy/README.md` 执行**，不要另起一套。
- `deploy/env.example` 是后端生产配置的公开样本（`.gitignore` 已显式放行）。
  真实 `server/.env` 含密钥，**绝不入库**。
- 生产三项硬约束：`HOST=127.0.0.1`、`TRUST_PROXY=true`、`COOKIE_SECURE=true`。
  第三项与 HTTPS 必须同步 —— 开了它却没有 HTTPS，表现为「登录成功但刷新掉线」。
- 素材目录（226 MB）**不在 git 里**，部署时须单独上传；漏传则资料库为空。
- 改了后端代码**必须重启后端进程**，`deploy/deploy.sh` 已包含这一步。

## 硬性约定

- **全站浅色主题**：不要用 `bg-night-*` / `text-white` 这类深色面。
- **涨跌配色按 A 股**：涨=红、跌=绿（与欧美相反）。
- 会员口径对外统一「**2000+**」（累计）；成立时间 **2002 年 9 月**
  （写「2006 年成立」即错误）。成立年份散落在时间轴、`about_content`、
  `about_stats`、`PartnerLogos` 多处，改一处要顺带查其余。
- 受限内容的读与写**共用同一道闸门**；前端守卫只是体验层，
  真隔离在后端按会话判定。新增 `/:id` 子路由前先问「这里要不要闸门」。
- 401 = 没登录，403 = 权限不够。区分开，不要混用。
- 只改 `seed.ts` 不递增 `SEED_REV` → 那台浏览器永远看不到新内容。

## Minimal Delivery Paths

### 新增页面（5 步）

1. 建 `src/pages/<Name>.tsx`。
2. 在 `src/router/index.tsx` 注册路由；需要登录就包 `RequireAuth`。
3. 复用 `src/components/site/*` 与 `src/components/admin/AdminUI.tsx` 的既有原语。
4. 需要数据就走 `src/lib/backendApi.ts`。
5. 跑 `pnpm check`。

### 新增组件（4 步）

1. 建在 `src/components/site/`（对外）或 `src/components/admin/`（后台）。
2. props 与回调显式标类型。
3. Tailwind 优先，合并类名用 `cn`。
4. 跑 `pnpm check`。

### 新增后端接口（5 步）

1. 在 `server/src/routes/` 的对应路由文件里加处理函数。
2. 在 `server/src/app.js` 的 `ROUTES` 表登记 `method + 路径模板 + target`。
3. 需要鉴权就从 `ctx.guards` 取闸门（`admin` / `accounts` / `resources`）。
4. 在 `server/test/` 补用例，覆盖**正常路径 + 越权路径**。
5. 跑 `npm test` 与 `npm run verify`。

## Allowed Changes

- `src/pages/**`、`src/components/**`、`src/lib/**`、`src/router/**`、`src/data/**`
- `server/src/**`、`server/test/**`、`server/scripts/**`
- 文档（`AGENTS.md`、`README.md`、`VERIFY.md`）

## Forbidden Changes

- 不要换包管理器（`pnpm` 是硬要求）。
- 不要新增平行的 agent 规则文档（**本文件是单一出处**）。
- 不要引入第二套框架写法（保持 React idioms）。
- 不要为了让数字好看而删掉被闸门挡下的数据记录 —— 挡在前台是 `isLibraryItem()` 的职责。

## Pre-submit Checklist

1. `pnpm check` 通过。
2. 动了后端：`cd server && npm test` 与 `npm run verify` 通过。
3. 动了权限、数据源或归类规则：**必须复跑**上述两项（有回归用例专门看守这些边界）。
4. 改了 `src/data/seed.ts` 正文：`SEED_REV` 已递增。
5. 新增路由/页面/接口遵循上面的映射表与命名习惯。
