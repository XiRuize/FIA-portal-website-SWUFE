# 上线操作手册 — 西南财经大学金融投资协会官网

> 面向「从零开始把站点放到公网」的完整流程。
> 每一步都给**可复制的命令**和**怎么判断这步成功了**。
>
> 目录结构：
> - `README.md`（本文件）— 从买到上线的主流程
> - `env.example` — 后端环境变量样本
> - `nginx/fia.conf` — Nginx 站点配置
> - `systemd/fia-backend.service` — 后端常驻服务
> - `setup-server.sh` — 服务器初始化（首次执行一次）
> - `deploy.sh` — 日常部署（每次发版执行）
> - `gen-secret.sh` — 生成指纹密钥

---

## 零、先看懂这套架构

这个项目**不是纯静态站**，这决定了它不能托管在 Vercel / Netlify / GitHub Pages 上。

它包含三个必须常驻的部分：

| 部分 | 说明 | 为什么必须常驻 |
| --- | --- | --- |
| 前端构建产物 | `dist/`，纯静态 JS/CSS/HTML | 可以托管在任意静态服务上 |
| Node 后端 | `server/`，端口 **8787** | 账号登录、资料库访问闸门、点赞去重都靠它，是进程不是文件 |
| 数据库与素材 | `server/data/fia.db` + `素材目录`（约 226 MB） | 后端读写，必须与后端同机 |

因此唯一合理的方案是：**一台云服务器，Nginx 同时负责发静态文件和转发 `/api` 到本地后端**。

```
浏览器 ──443──> Nginx ──┬── /assets、/  ──> dist/ 静态文件
                        └── /api/*      ──> 127.0.0.1:8787  Node 后端
                                                  │
                                          素材目录 + SQLite
```

---

## 一、买域名

### 在哪买

| 渠道 | 说明 |
| --- | --- |
| 腾讯云 / 阿里云 / 华为云 | 推荐。域名与服务器同平台，备案流程自动关联，省事 |
| 校园渠道 | 部分高校有教育网域名额度，需学校信息中心审批，周期长 |

### 买什么样的

| 项 | 建议 |
| --- | --- |
| 后缀 | **`.com`**（约 ¥65/年）或 **`.cn`**（约 ¥29/年） |
| 名称 | 短、好念、与社团相关，如 `fia-swufe.com`、`swufefia.cn` |
| 年限 | 建议直接买 3 年，省得年年操心续费 |
| 隐私保护 | 开启（免费），避免注册人姓名/手机号被公开查询 |

⚠️ **不要买 `.edu.cn`**。该后缀需要**西南财经大学官方主体资质**（事业单位法人证书等），学生社团无法以自身名义申请。如果希望能用 `edu.cn` 域名，需要走学校信息中心，由学校作为主体申请。

### 买完立刻做两件事

1. **实名认证**（腾讯云/阿里云的要求），未实名会被暂停解析。
2. **决定用不用 `www`**。建议主域名用不带 www 的（`fia-swufe.com`），并把 `www.fia-swufe.com` 也解析过去做跳转 —— Nginx 配置里已经写好两个都接。

---

## 二、买服务器

### 配置怎么选

| 配置 | 首年参考价 | 评价 |
| --- | --- | --- |
| 2核2G 3M带宽 | ¥88–112 | 能跑，但**前端构建时可能 OOM**，需要配 swap |
| **2核4G 5M带宽** | **¥150–400** | **推荐**。构建、后端、SQLite 都有充足余量 |
| 4核8G | ¥800+ | 这个项目用不到 |

**买的时候注意四点**：

1. **必须选境内节点**（重庆/成都/上海/广州等）。选了香港/新加坡虽然免备案，但校园网访问慢，且不符合「校内师生为主、公网可访问」的定位。
2. **区域选成都**（离学校近，延迟低）。备案会归口到**四川省通信管理局**。
3. **系统盘 ≥ 40 GB**。素材 226 MB 不大，但系统 + Node + 依赖 + 日志 + 备份，40 GB 是安全线。
4. **带宽按固定带宽买，不要按流量计费**。PDF 下载会吃流量，按量计费容易产生意外账单。

### 服务器买完立刻做三件事

```bash
# ① 用 SSH 登进去（腾讯云/阿里云控制台可重置密码）
ssh root@<服务器公网IP>

# ② 查看配置，确认没买错
free -m && df -h / && nproc

# ③ 记录公网 IP —— 后面配域名解析要用
curl -s ifconfig.me
```

---

## 三、提交 ICP 备案（必须，且要趁早）

**境内服务器的 80 / 443 端口在备案通过前是被封的**，域名无法访问。备案要 10–20 个工作日，所以**买完服务器当天就提交**，等待期正好用来做环境准备。

### 备案流程

1. 进云厂商控制台的「备案」入口，选择「**首次备案**」。
2. 主体性质选「**个人**」（学生社团无法提供企业营业执照，个人备案是可行路径）。
3. 填写：
   - 主体信息：你的姓名、身份证、手机号、真实住址
   - 网站信息：域名、网站名称（写「西南财经大学金融投资协会」或类似）
   - 服务器：选择刚买的那台（备案要求服务器在有效期内，且剩余时长通常 ≥ 3 个月）
4. **网站服务内容**选「其他」或「学校社团」，**不要**选新闻/出版/教育等需要前置审批的类别 —— 那会触发额外审批流程。
5. 上传证件照、做**人脸核验**（云厂商 App 扫码）。
6. 提交后：云厂商初审（1–2 天）→ 提交管局 → 管局审核（10–20 天）→ 短信通知结果。

### 备案通过后再做一步

**公安联网备案**：备案通过后 30 日内，到「全国互联网安全管理服务平台」登记。这一步常被忽略，但属于法定义务。云厂商控制台通常有直达入口。

### 备案通过后

在云厂商的备案控制台，找到「**备案域名解析**」，把域名添加到服务器的白名单 —— 部分厂商需要这一步才会真正放行。

---

## 四、初始化服务器

备案等待期间就可以做这一步（不涉及 80/443，不受备案限制）。

### 4.1 上传代码

把代码放到服务器。两种方式：

**方式 A：git（推荐，后续 `deploy.sh` 能一键更新）**

```bash
sudo mkdir -p /var/www/fia
cd /var/www/fia
git clone <你的仓库地址> current
```

**方式 B：直接传压缩包（没有远程仓库时）**

在本地 Windows 上打包（在项目根目录执行）：

```bash
# 排除 node_modules / dist / .git，只传源码
tar --exclude=node_modules --exclude=dist --exclude=.git \
    -czf fia-site.tar.gz .
```

然后传到服务器：

```bash
scp fia-site.tar.gz root@<服务器IP>:/var/www/fia/
```

服务器上解开：

```bash
cd /var/www/fia && mkdir -p current && tar -xzf fia-site.tar.gz -C current
```

### 4.2 上传素材目录 ⚠️ 最容易漏的一步

**素材目录不在 git 里**（`.gitignore` 刻意排除了 226 MB 的第三方 PDF/电子书），必须单独传。

在本地 Windows 上：

```bash
scp -r "资料分享模块素材" root@<服务器IP>:/var/www/fia/current/
```

⚠️ 目录名必须保持 `资料分享模块素材`，因为后端默认按这个名字找（相对 `server/` 的 `../资料分享模块素材`）。如果改了名字，要同步改 `server/.env` 的 `MATERIALS_DIR`。

传完后在服务器上确认：

```bash
du -sh /var/www/fia/current/资料分享模块素材
# 应显示约 226M
```

### 4.3 运行初始化脚本

```bash
cd /var/www/fia/current
sudo bash deploy/setup-server.sh
```

这个脚本会装 Node 22、Nginx、配置防火墙（放行 22/80/443，**不放行 8787**）。

### 4.4 配置环境变量

```bash
cd /var/www/fia/current
cp deploy/env.example server/.env
bash deploy/gen-secret.sh
```

然后编辑 `server/.env`，**必改三项**：

```bash
nano server/.env
```

```ini
HOST=127.0.0.1          # 只绑回环，后端不与公网直接接触
TRUST_PROXY=true        # 挂在 Nginx 之后必须开，否则登录限流拿不到真实 IP
COOKIE_SECURE=true      # 线上是 HTTPS 必须开，否则登录后刷新即掉线
MATERIALS_DIR=../资料分享模块素材    # 确认路径正确
CORS_ORIGINS=https://你的域名,https://www.你的域名
```

⚠️ **`COOKIE_SECURE=true` 和 HTTPS 必须同步**。开了它但没有 HTTPS，浏览器会拒收会话 Cookie，表现是「登录成功，一刷新就退回未登录」—— 这个现象很容易被误判成后端 bug。

### 4.5 注册后端常驻服务

```bash
sudo cp deploy/systemd/fia-backend.service /etc/systemd/system/
sudo nano /etc/systemd/system/fia-backend.service
```

检查这两行的路径与实际一致：

```ini
WorkingDirectory=/var/www/fia/current/server
EnvironmentFile=-/var/www/fia/current/server/.env
```

补一个关键的加固项（找到 `[Unit]` 段，加入）：

```ini
StartLimitIntervalSec=300
StartLimitBurst=10
```

然后启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable fia-backend
```

此时先别启动 —— 数据库还没建，等首次部署时会一起处理。

---

## 五、配置 Nginx

```bash
sudo cp deploy/nginx/fia.conf /etc/nginx/sites-available/fia.conf
sudo nano /etc/nginx/sites-available/fia.conf
```

把文件里**所有** `<你的域名>` 替换成实际域名（有两处 `server_name`、两行证书路径）。可以用 `sed` 一次改完：

```bash
sudo sed -i 's/<你的域名>/fia-swufe.com/g' /etc/nginx/sites-available/fia.conf
```

⚠️ 证书路径那两行此时指向的文件还不存在，`nginx -t` 会报错。**先注释掉这两行和 `ssl_certificate*`**，等第 6 步签证书时 certbot 会自动补上：

```bash
# 临时注释：
sudo sed -i 's|^\(\s*ssl_certificate \)|#\1|; s|^\(\s*ssl_certificate_key \)|#\1|' \
  /etc/nginx/sites-available/fia.conf
```

启用站点并移除默认站点：

```bash
sudo ln -sf /etc/nginx/sites-available/fia.conf /etc/nginx/sites-enabled/fia.conf
sudo rm -f /etc/nginx/sites-enabled/default    # 不删会和 80 端口冲突
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` 输出 `syntax is ok` + `test is successful` 才算过。

---

## 六、首次部署

```bash
cd /var/www/fia/current
sudo bash deploy/deploy.sh
```

脚本依次做：装依赖 → 构建前端 → 建库播种 → 扫描素材 → 重启后端 → 探活。

**怎么看成功**：最后输出「部署完成」，且下面这几行都是 `✓ ... → 200`：

```
✓ 后端健康检查 → 200
✓ /api/resources/categories → 200
✓ /api/news/status → 200
```

单独确认后端起来了：

```bash
sudo systemctl status fia-backend
sudo journalctl -u fia-backend -n 40 --no-pager
```

启动日志里要看到：

```
资料条目      : N 条          ← 不是 0
素材目录      : /var/www/.../资料分享模块素材 ✓
指纹密钥      : 已配置 ✓      ← 不能是「未配置」
Cookie Secure : true（需 HTTPS）
```

如果 `资料条目` 是 0 → 素材目录没找到，检查 `MATERIALS_DIR`。
如果 `指纹密钥` 显示未配置 → 重跑 `bash deploy/gen-secret.sh` 并重启服务。

---

## 七、配 HTTPS 证书

免费证书两条路，推荐 Let's Encrypt（自动续期）。

### 7.1 先配 DNS 解析

在域名控制台添加解析记录（**备案通过后才生效**）：

| 主机记录 | 记录类型 | 记录值 |
| --- | --- | --- |
| `@` | A | 服务器公网 IP |
| `www` | A | 服务器公网 IP |

验证解析生效：

```bash
# 在本地 Windows 或服务器上执行，应输出你的服务器 IP
nslookup fia-swufe.com
```

### 7.2 签证书

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d fia-swufe.com -d www.fia-swufe.com
```

certbot 会：验证域名归属 → 签发证书 → **自动改写 Nginx 配置**（补上第 5 步注释掉的 `ssl_certificate` 行）→ 配置 80→443 跳转。

看到 `Congratulations!` 并且 `nginx -t` 通过就成功了。

### 7.3 验证自动续期

```bash
sudo certbot renew --dry-run
```

输出 `Congratulations, all simulated renewals succeeded` 才算过。证书有效期 90 天，certbot 会自动续，但**自动续期依赖 80 端口的 `/.well-known/acme-challenge/` 直通**（`fia.conf` 里已经写好，别删）。

---

## 八、逐项验证

浏览器打开 `https://fia-swufe.com`，按顺序检查：

| # | 检查项 | 期望结果 | 不通过的常见原因 |
| --- | --- | --- | --- |
| 1 | 首页加载 | 各版块（合作单位、时间轴、行情终端）正常显示 | `/api` 反代没配 → 版块空白 |
| 2 | 合作单位跑马灯 | 三行在动 | 见 `PITFALLS.md` 的 keyframes 问题 |
| 3 | 行情终端 | 能搜到股票、K 线出图 | 服务器无法访问腾讯行情接口 |
| 4 | 登录 `<已清除> / <已清除>` | 登录成功，刷新后仍在登录态 | `COOKIE_SECURE` 与 HTTPS 不匹配 |
| 5 | 后台「栏目与网站管理」 | 能看到三个顶级栏目 | 数据库未正确播种 |
| 6 | 资料库列表 | 有资料，分类正确 | 素材目录未上传或路径错 |
| 7 | 下载一份 PDF | 能下载完整文件 | Nginx `proxy_read_timeout` 太短 |
| 8 | 未登录访问受限资料 | 被拦下并提示登录 | 闸门应拦下，能进就是安全问题 |

再加一项命令行检查（在服务器上）：

```bash
# 经 Nginx 的完整链路
curl -s https://fia-swufe.com/api/health | head -c 200

# 确认后端没暴露在公网（应超时或拒绝连接）
curl -s --max-time 5 http://<公网IP>:8787/api/health && echo "⚠️ 8787 暴露了！" || echo "✓ 8787 未暴露"
```

---

## 九、日常维护

### 发版（改了代码后）

```bash
cd /var/www/fia/current
sudo bash deploy/deploy.sh
```

改了 `src/data/seed.ts` 的内容时，脚本会重建前端，但**浏览器缓存**可能还是旧的 —— 提醒用户 Ctrl+F5，或确认 `SEED_REV` 已递增。

### 备份

需要备份的是**三样**，素材目录不用（它是静态的）：

```bash
# 数据库（含账号、会话、覆写表）
sudo cp /var/www/fia/current/server/data/fia.db /root/backup/fia-$(date +%F).db

# 覆写表
sudo cp /var/www/fia/current/server/data/production-meta.json /root/backup/

# 环境变量
sudo cp /var/www/fia/current/server/.env /root/backup/env-$(date +%F)
```

建议加一条 crontab 每天自动备份数据库：

```bash
sudo crontab -e
# 加入（每天凌晨 3 点）
0 3 * * * cp /var/www/fia/current/server/data/fia.db /root/backup/fia-$(date +\%F).db
```

### 看日志

```bash
# 后端日志（实时）
sudo journalctl -u fia-backend -f

# Nginx 访问/错误日志
sudo tail -f /var/log/nginx/fia.access.log
sudo tail -f /var/log/nginx/fia.error.log
```

### 常见故障速查

| 现象 | 排查方向 |
| --- | --- |
| 首页能开但资料库/新闻空白 | Nginx 的 `/api` 反代没配或后端没起 |
| 登录成功但刷新掉线 | `COOKIE_SECURE=true` 但没 HTTPS，或 Cookie 域名不匹配 |
| 连续输错密码后绑不上 | `TRUST_PROXY` 没开 → 所有访客共用一个限流桶 |
| 改了后端代码没生效 | **后端进程没重启**（`deploy.sh` 会重启，手工改需 `systemctl restart fia-backend`） |
| PDF 下载中断 | Nginx `proxy_read_timeout` 太短，或 `proxy_buffering on` 挡住了 Range |
| 网站打不开且已备案 | 检查云厂商安全组是否放行 80/443；`ufw status` |
| 证书续期失败 | 80 端口跳转配置把 `/.well-known/acme-challenge/` 也跳走了 |

---

## 附录 A：费用清单

| 项目 | 首年 | 续费 |
| --- | --- | --- |
| 域名 `.com` | ¥65 | ¥65–85/年 |
| 域名 `.cn` | ¥29 | ¥39/年 |
| 服务器 2核4G | ¥150–400 | ¥400–800/年 |
| SSL 证书 | ¥0（Let's Encrypt） | ¥0 |
| 备案 | ¥0 | ¥0 |
| **合计** | **约 ¥215–465** | **约 ¥465–890/年** |

学生认证（腾讯云/阿里云「校园计划」）通常能再省 30–50%。

## 附录 B：安全清单（上线前逐项确认）

- [ ] `server/.env` 未被提交到 git（`.gitignore` 已排除，用 `git status` 确认）
- [ ] `FINGERPRINT_SECRET` 是随机生成的，不是默认占位符
- [ ] 云厂商安全组只放行 22 / 80 / 443，**没有** 8787
- [ ] `ufw status` 确认同上
- [ ] SSH 已禁用密码登录，改用密钥（`/etc/ssh/sshd_config` 的 `PasswordAuthentication no`）
- [ ] 演示账号 `guest / <已清除>` 的到期时间已核查，演示完毕及时吊销
- [ ] 管理员账号 `<已清除>` 的密码已从默认值改掉
- [ ] 已删除服务器上所有开发用临时文件与备份 tar 包（避免源码与凭据泄露）
- [ ] 已配置自动备份数据库
