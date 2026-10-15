#!/usr/bin/env bash
#
# ---------------------------------------------------------------------------
# 西南财经大学金融投资协会官网 · 一键部署脚本
#
# 在服务器上执行，把「拉代码 → 装依赖 → 构建前端 → 建库 → 扫描素材
# → 重启后端 → 验证」串成一条命令。
#
# 用法：
#   bash deploy/deploy.sh              # 完整部署
#   bash deploy/deploy.sh --no-scan    # 跳过素材扫描（内容没变时更快）
#   bash deploy/deploy.sh --skip-build # 只重启后端，不重新构建前端
#
# ⚠️ 假设前提（首次部署请先照 deploy/README.md 走一遍）：
#   1. 代码已在 $APP_DIR，且 server/.env 已按 deploy/env.example 填好
#   2. server/.env 中 TRUST_PROXY=true、COOKIE_SECURE=true
#   3. Nginx 与 systemd 服务已配置（deploy/nginx、deploy/systemd）
#
# 本脚本刻意不做「首次部署」的初始化工作（装 Node/Nginx/建目录），
# 那些是一次性动作，混进日常部署脚本会让它难以理解且容易误伤。
# ---------------------------------------------------------------------------

set -euo pipefail

# ---- 可按需修改 ----
APP_DIR="${APP_DIR:-/var/www/fia/current}"
SERVICE_NAME="${SERVICE_NAME:-fia-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/health}"

# ---- 参数解析 ----
RUN_SCAN=1
RUN_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-scan)    RUN_SCAN=0 ;;
    --skip-build) RUN_BUILD=0 ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

# ---- 输出helpers ----
C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_STEP='\033[36m'
step() { printf "\n${C_STEP}==> %s${C_RESET}\n" "$1"; }
ok()   { printf "${C_OK}  ✓ %s${C_RESET}\n" "$1"; }
warn() { printf "${C_WARN}  ! %s${C_RESET}\n" "$1"; }
die()  { printf "${C_ERR}  ✗ %s${C_RESET}\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "0/7 前置检查"
# ---------------------------------------------------------------------------
[ -d "$APP_DIR" ] || die "应用目录不存在：$APP_DIR（用 APP_DIR=... 指定）"
cd "$APP_DIR"

command -v node >/dev/null || die "找不到 node，请先安装 Node 22+"
command -v pnpm >/dev/null || die "找不到 pnpm，请先 npm i -g pnpm"
[ -f server/.env ] || die "server/.env 不存在 —— 后端配置与 seed 账号口令都从这里读，且 seed 脚本没有默认管理员口令（cp deploy/env.example server/.env 后填写）"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node 版本过低（当前 $(node -v)），后端需要 >= 22.5.0"

# 后端用了 node:sqlite，它在 22.5.0 之后才可用；低于此版本启动即报错。
ok "Node $(node -v) · pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
step "1/7 同步代码"
# ---------------------------------------------------------------------------
if [ -d .git ]; then
  BEFORE="$(git rev-parse --short HEAD)"
  git fetch --all --quiet
  git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)" --quiet
  AFTER="$(git rev-parse --short HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then
    ok "已是最新（$AFTER）"
  else
    ok "更新 $BEFORE → $AFTER"
  fi
else
  warn "不是 git 仓库，跳过代码同步"
fi

# 磁盘余量提醒：素材 + 数据库 + 依赖大约需要 2 GB
AVAIL_MB="$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')"
if [ "${AVAIL_MB:-0}" -lt 1536 ]; then
  warn "可用磁盘仅 ${AVAIL_MB}MB，建议清理（pnpm store prune / 删除旧发布目录）"
fi

# ---------------------------------------------------------------------------
step "2/7 安装依赖"
# ---------------------------------------------------------------------------
# 后端零运行时第三方依赖，只有前端需要装包。
# 用 --frozen-lockfile 保证服务器上装出的版本与开发机一致。
pnpm install --frozen-lockfile
ok "依赖就绪"

# ---------------------------------------------------------------------------
if [ "$RUN_BUILD" -eq 1 ]; then
  step "3/7 构建前端"
  # ⚠️ 构建峰值内存 1–2 GB。1 GB 内存的机器会 OOM，
  #    可临时加大 swap 或升配到 2 GB 以上。
  pnpm build
  [ -f dist/index.html ] || die "构建未产出 dist/index.html"
  ok "构建完成：$(du -sh dist | cut -f1)"
else
  step "3/7 构建前端（已跳过）"
fi

# ---------------------------------------------------------------------------
step "4/7 初始化数据库"
# ---------------------------------------------------------------------------
cd "$APP_DIR/server"
# seed.mjs 是幂等的：已存在的记录不会被覆盖，
# 因此重复执行安全，且能补齐新增的默认设置项。
node scripts/seed.mjs
ok "数据库就绪：$(node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.DB_PATH||'./data/fia.db',{readOnly:true});
  const n=db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  console.log(n+' 个账号');
" 2>/dev/null || echo '（统计跳过）')"

# ---------------------------------------------------------------------------
if [ "$RUN_SCAN" -eq 1 ]; then
  step "5/7 扫描素材目录"
  # 会把素材目录里的文件与 production-meta.json 的覆写信息写入数据库。
  # 素材没变动时可加 --no-scan 跳过，省几十秒。
  node scripts/scan-resources.mjs
  ok "素材扫描完成"
else
  step "5/7 扫描素材目录（已跳过）"
fi

# ---------------------------------------------------------------------------
step "6/7 重启后端服务"
# ---------------------------------------------------------------------------
cd "$APP_DIR"
if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2
  # systemd 会把「进程起来又立刻退出」表现为 active 但反复重启，
  # 因此不能只看 is-active 就下结论。is-active 通过后还要真的探活一次。
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "服务已启动（$SERVICE_NAME）"
  else
    warn "服务状态异常，最近日志："
    sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
    die "后端启动失败"
  fi
else
  warn "未找到 systemd 服务 $SERVICE_NAME，跳过重启"
  warn "请先照 deploy/README.md 第 6 步注册服务"
fi

# ---------------------------------------------------------------------------
step "7/7 验证"
# ---------------------------------------------------------------------------
FAIL=0

check() {
  local label="$1" url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok "$label → 200"
  else
    warn "$label → $code"
    FAIL=1
  fi
}

check "后端健康检查" "$HEALTH_URL"

# 经 Nginx 的探活（若已配好）
if curl -s -o /dev/null --max-time 5 -k https://127.0.0.1/ 2>/dev/null; then
  check "Nginx 首页" "https://127.0.0.1/"
  check "Nginx → 后端代理" "https://127.0.0.1/api/health"
fi

# 关键接口抽查
API_BASE="http://127.0.0.1:8787"
for ep in "/api/resources/categories" "/api/news/status" "/api/settings"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_BASE$ep" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok "$ep → 200"
  else
    warn "$ep → $code"
  fi
done

printf "\n"
if [ "$FAIL" -eq 0 ]; then
  printf "${C_OK}部署完成。${C_RESET}\n"
else
  printf "${C_WARN}部署完成，但有检查项未通过，请查看上方输出。${C_RESET}\n"
fi

cat <<'EOF'

后续人工验证（脚本无法代替）：
  1. 浏览器打开 https://fia2002.cn/          —— 检查首页各版块正常
  2. 用 server/.env 里的 SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD 登录
     → 进入「栏目与网站管理」 —— 检查后台可用
  3. 打开一条受限资料 → 下载 PDF             —— 检查闸门与大文件传输
  4. 检查登录 Cookie 是否持久                —— 刷新页面不应掉登录

EOF
