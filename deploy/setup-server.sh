#!/usr/bin/env bash
#
# ---------------------------------------------------------------------------
# 西南财经大学金融投资协会官网 · 服务器初始化（仅首次部署执行一次）
#
# 在**全新**的 Ubuntu 22.04 / 24.04 服务器上以 root 或有 sudo 权限的用户执行：
#   sudo bash deploy/setup-server.sh
#
# 做四件事：
#   1. 装 Node 22 + Nginx + 常用工具
#   2. 建应用目录 /var/www/fia
#   3. 生成 FINGERPRINT_SECRET 并写入 server/.env（若尚无）
#   4. 配好防火墙（只放行 SSH / HTTP / HTTPS）
#
# ⚠️ 本脚本可重复执行（幂等），但不会覆盖已有的 .env。
# ⚠️ 执行完还需要手动做：上传代码素材、配 Nginx 站点、注册 systemd 服务、
#    申请证书、提交备案 —— 见 deploy/README.md。
# ---------------------------------------------------------------------------

set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/fia}"
DOMAIN="${DOMAIN:-}"

C_RESET='\033[0m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_STEP='\033[36m'
step() { printf "\n${C_STEP}==> %s${C_RESET}\n" "$1"; }
ok()   { printf "${C_OK}  ✓ %s${C_RESET}\n" "$1"; }
warn() { printf "${C_WARN}  ! %s${C_RESET}\n" "$1"; }
die()  { printf "${C_ERR}  ✗ %s${C_RESET}\n" "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 或 sudo 执行"

# ---------------------------------------------------------------------------
step "1/5 检查系统"
# ---------------------------------------------------------------------------
if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "系统：${PRETTY_NAME:-未知}"
  case "$ID" in
    ubuntu|debian) ;;
    *) warn "本脚本针对 Ubuntu/Debian 编写，当前系统可能需要对命令稍作调整" ;;
  esac
fi

TOTAL_MEM_MB="$(free -m | awk '/^Mem:/ {print $2}')"
if [ "${TOTAL_MEM_MB:-0}" -lt 1800 ]; then
  warn "内存仅 ${TOTAL_MEM_MB}MB，前端构建可能 OOM（建议 2GB 以上，或建 2GB swap）"
fi

# ---------------------------------------------------------------------------
step "2/5 安装 Node 22 与 Nginx"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git nginx ufw \
  build-essential python3 >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  # Node 22 起才带稳定的 node:sqlite，后端强依赖它
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "已安装 Node $(node -v)"
else
  ok "Node 已就绪：$(node -v)"
fi

if ! command -v pnpm >/dev/null; then
  npm install -g pnpm >/dev/null 2>&1
fi
ok "pnpm $(pnpm -v)"

systemctl enable --now nginx >/dev/null 2>&1 || true
ok "Nginx 已启用"

# ---------------------------------------------------------------------------
step "3/5 创建应用目录"
# ---------------------------------------------------------------------------
mkdir -p "$APP_ROOT"
mkdir -p /var/www/certbot
ok "应用根目录：$APP_ROOT"

# 若当前部署用户不是 root，把目录所有权交给他，
# 否则 git pull / pnpm build 会因权限不足失败。
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  chown -R "$SUDO_USER":"$SUDO_USER" "$APP_ROOT"
  ok "目录所有权已交给 $SUDO_USER"
fi

# ---------------------------------------------------------------------------
step "4/5 生成指纹密钥"
# ---------------------------------------------------------------------------
ENV_FILE="$APP_ROOT/current/server/.env"
if [ -f "$ENV_FILE" ]; then
  ok "已存在 $ENV_FILE，未改动"
else
  warn "尚无 $ENV_FILE"
  warn "请先上传代码，然后执行："
  printf '\n    cd %s && cp deploy/env.example server/.env\n' "$APP_ROOT/current"
  printf '    SECRET=$(openssl rand -hex 32)\n'
  printf '    sed -i "s|请替换为openssl-rand-hex-32的输出|$SECRET|" server/.env\n\n'
  warn "⚠️ 或直接运行仓库里的便捷命令："
  printf '    bash deploy/gen-secret.sh\n\n'
fi

# ---------------------------------------------------------------------------
step "5/5 配置防火墙"
# ---------------------------------------------------------------------------
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
# 8787 刻意不放行：后端只绑回环，外部不该能直连
ufw --force enable >/dev/null 2>&1 || true
ok "防火墙：放行 22 / 80 / 443，8787 不对公网开放"

cat <<EOF

${C_OK}服务器初始化完成。${C_RESET}

接下来照 deploy/README.md 执行：
  1. 上传代码到 $APP_ROOT/current
  2. 上传素材目录（226 MB，不在 git 里）
  3. cp deploy/env.example server/.env 并填写 FINGERPRINT_SECRET
  4. 配 Nginx：把 deploy/nginx/fia.conf 放到 /etc/nginx/sites-available/
  5. 注册 systemd：把 deploy/systemd/fia-backend.service 放到 /etc/systemd/system/
  6. 首次部署：bash deploy/deploy.sh
  7. 申请证书：certbot --nginx -d <你的域名>

EOF
