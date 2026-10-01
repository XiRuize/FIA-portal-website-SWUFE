#!/usr/bin/env bash
#
# ---------------------------------------------------------------------------
# 生成 FINGERPRINT_SECRET 并写入 server/.env
#
# 在项目根目录执行：
#   bash deploy/gen-secret.sh
#
# 背景：后端用这个密钥做点赞指纹的 HMAC。不配置时每个进程会生成一个随机值，
# 表现为「后端一重启，所有人对同一条资料的点赞都能再点一次」。
# 因此生产环境必须固定下来。
#
# 幂等：已有非空值时不会覆盖（覆盖会让已有的点赞指纹全部失效）。
# ---------------------------------------------------------------------------

set -euo pipefail

ENV_FILE="${1:-server/.env}"
EXAMPLE="deploy/env.example"
PLACEHOLDER="请替换为openssl-rand-hex-32的输出"

command -v openssl >/dev/null || { echo "找不到 openssl，请先 apt install openssl" >&2; exit 1; }

# 生成 32 字节 = 64 位十六进制
SECRET="$(openssl rand -hex 32)"

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$EXAMPLE" ] || { echo "找不到 $EXAMPLE，请在项目根目录执行本脚本" >&2; exit 1; }
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$EXAMPLE" "$ENV_FILE"
  echo "已从 $EXAMPLE 创建 $ENV_FILE"
fi

CURRENT="$(grep -E '^FINGERPRINT_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"

if [ -n "$CURRENT" ] && [ "$CURRENT" != "$PLACEHOLDER" ]; then
  echo "FINGERPRINT_SECRET 已有取值，保持不变（避免已有点赞指纹失效）。"
  echo "如需强制轮换，先手工清空该项再执行本脚本。"
  echo
  echo "README 提醒：轮换后所有人的历史点赞归零。"
  exit 0
fi

# 用 | 作 sed 分隔符，避免值里可能出现的 / 引发问题
if [ -z "$CURRENT" ]; then
  printf '\nFINGERPRINT_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
else
  sed -i "s|^FINGERPRINT_SECRET=.*|FINGERPRINT_SECRET=$SECRET|" "$ENV_FILE"
fi

echo "已写入新的 FINGERPRINT_SECRET 到 $ENV_FILE"
echo
echo "⚠️ 检查以下三项（生产环境必须如此）："
grep -E '^(TRUST_PROXY|COOKIE_SECURE|HOST)=' "$ENV_FILE" || echo "  （未找到 TRUST_PROXY / COOKIE_SECURE / HOST，请对照 env.example 补齐）"
echo
echo "改完后重启后端：sudo systemctl restart fia-backend"
