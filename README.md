# 西南财经大学金融投资协会 · 门户网站

> 本项目是 **西南财经大学金融投资协会（Financial Investment Association, FIA）** 的**门户网站**。
> 它对外介绍协会、沉淀历年研究与学习资料，并以实时行情看板把「连接课堂与市场」的宗旨延伸到线上。

---

## 一、关于协会

西南财经大学金融投资协会成立于 **2002 年 9 月**，是由西南财经大学在校学生自发组织、
面向全校同学的**学术实践类社团**。

| 项 | 内容 |
| --- | --- |
| 简称 | 西财金融投资协会 / FIA |
| 成立 | 2002 年 9 月 |
| 性质 | 面向全校同学的学术实践类社团 |
| 宗旨 | 连接课堂与市场 |
| 口号 | 以研究立身 · 以投资会友 |
| 组织 | 会长团统筹，下设研究部、数据部、宣传部、外联部与赛事组 |
| 概况 | 累计发展会员 2000 余人，会友广泛就职于互联网、证券、银行、基金等领域的头部机构 |

协会长期举办内部培训、读书会、研究报告评审与模拟投资赛事，
并定期组织成员参访证券公司、基金公司与金融科技企业，
为成员搭建从课堂知识到市场实践的桥梁。

---

## 二、项目简介

这是一个**前后端同仓**的站点项目，不是静态页面站：

- **前端**：React 18 + Vite + TypeScript，`createHashRouter` 哈希路由
- **后端**：自建的零依赖 Node 服务（`server/`），承载账号登录、资料库访问闸门与点赞去重
- **数据**：本地 SQLite + 素材目录（**素材不入库**，见第七节）

前端经开发服务器或 Nginx 的 `/api` 代理访问后端，保持同源 Cookie。

---

## 三、功能模块

| 模块 | 说明 |
| --- | --- |
| 首页 | 协会介绍、发展时间轴、合作单位与会友去向、实时行情看板 |
| 资料库 | 电子书籍 / 数据 / 研报 / 课程资源；按「磁盘目录」与「展示类目」双维度归类 |
| 社团成员产出 | 与资料库共用数据表，按部门（研发部 / 培训部 / 宣传中心）独立切分 |
| 行情终端 | 本机 free-stockdb 优先，不可达时自动回退腾讯行情（日 K + 实时快照） |
| 后台管理 | 数据 / 内容 / 账号三大栏目，含访问申请审批流、通知发件箱、延期权与重置口令 |
| 账号与权限 | 匿名 / viewer（带到期时间）/ admin 三层身份；受限内容的**读与写共用同一道闸门** |

---

## 四、技术栈

**前端**

- React 18 · Vite 5 · TypeScript（strict）
- Tailwind CSS 3 + Radix UI 原语
- React Router 7（Hash 路由）· React Hook Form + Zod

**后端**（`server/`）

- Node.js 原生 `node:http` + `node:sqlite` + `node:crypto`
- **零运行时第三方依赖** —— 部署时不需要 `npm install`

---

## 五、本地开发

### 环境要求

- **Node.js** >= 22.5.0（后端使用 `node:sqlite`，此为该模块的最低版本）
- **pnpm**（本项目**只使用 pnpm**，不要用 npm / yarn）

### 命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 前端开发服务器 http://127.0.0.1:5173
pnpm build            # 生产构建
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint src --ext ts,tsx
pnpm check            # 必过门禁：type-check + lint
```

后端在 `server/` 下单独启动：

```bash
cd server
node src/index.js     # 起后端，默认 127.0.0.1:8787
npm test              # 单元测试（node --test）
npm run verify        # 一键自检
npm run setup         # 建库播种 + 扫描素材目录
```

### 开站两条命令

```bash
cd server && node src/index.js                     # 后端 127.0.0.1:8787
npx vite --port 5173 --host 127.0.0.1              # 前端 127.0.0.1:5173
```

访问入口是 **`http://127.0.0.1:5173/#/`** —— 注意根路径 `/#/` 不可省略（哈希路由）。

探活三点：

```bash
curl -s http://127.0.0.1:8787/api/health           # 后端
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/   # 前端
curl -s http://127.0.0.1:5173/api/health           # 经前端代理访问后端
```

> ⚠️ **后端代码改完必须重启后端进程**，否则改动不生效。

---

## 六、目录结构

| 关注点 | 位置 |
| --- | --- |
| 路由页面 | `src/pages/*.tsx` |
| 站点组件 | `src/components/site/*` |
| 后台组件 | `src/components/admin/*` |
| 鉴权与会话 | `src/lib/auth.tsx` + `src/components/auth/RequireAuth.tsx` |
| 后端 API 客户端 | `src/lib/backendApi.ts` |
| 内容仓库 | `src/lib/store.tsx` + `contentApi.ts` + `localDb.ts` |
| 种子内容 | `src/data/seed.ts` |
| 路由注册表 | `src/router/index.tsx` |
| 后端入口 | `server/src/index.js` → `server/src/app.js` |
| 后端路由 / 服务层 | `server/src/routes/*.js` / `server/src/lib/*.js` |
| 后端测试 | `server/test/*.test.js` |
| 部署资产 | `deploy/`（Nginx / systemd / 脚本 / 上线手册） |

---

## 七、开发约定

- **全站浅色主题**：不使用深色面（`bg-night-*` / `text-white`）。
- **涨跌配色按 A 股惯例**：涨 = 红，跌 = 绿（与欧美相反）。
- **数据双通道**：内容仓库首次进入时探测云端可用性，不可达则落到本地存储 + 种子数据。
  改动 `src/data/seed.ts` 正文后，**必须递增文件顶部的 `SEED_REV`**，
  否则浏览器端缓存不会刷新，表现为「改了没生效」。
- **权限边界**：401 = 未登录，403 = 权限不足，两者不混用。
  前端守卫只是体验层，**真正的隔离在后端按会话判定**。
- **素材目录不在版本库内**：`资料分享模块素材/`（约 226 MB）绝大部分是第三方研报、
  电子书与课程讲义，出于**版权与体积**考虑已由 `.gitignore` 排除。
  部署时需单独上传至服务器，否则资料库模块为空。
- **改后端后必须重启服务**。

---

## 八、部署

生产环境是 **一台境内云服务器 + Nginx + systemd**，
**不能使用静态托管**（Vercel / Netlify / GitHub Pages 均不可行）——
后端是持有 SQLite 的常驻进程，且素材需与后端同机。

完整流程见 **[`deploy/README.md`](deploy/README.md)**，不要另起一套。

三项生产硬约束（缺一即出故障）：

```ini
HOST=127.0.0.1        # 后端只绑回环，不接触公网；安全组不放行 8787
TRUST_PROXY=true      # 挂 Nginx 后必开，否则登录限流退化为全站共用一个桶
COOKIE_SECURE=true    # 须与 HTTPS 同步，否则表现为「登录成功但刷新掉线」
```

---

## 九、说明

- 本站为协会**内部学习与信息展示**用途，不作商业运营。
- 仓库**不包含**第三方素材（券商研报、电子书、课程讲义等），
  相关版权归原作者与出版方所有。
- 行情数据来自公开接口，仅供学习参考，**不构成任何投资建议**。

---

© 西南财经大学金融投资协会
