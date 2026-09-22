#!/usr/bin/env bash
# 一键更新 + 发布：重跑数据导出 → 本地预览 → 提交推送。
# 用法： ./tools/publish.sh            （只更新数据并本地预览）
#        ./tools/publish.sh --push     （更新后提交并推送到 GitHub）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY_BIN="${PY_BIN:-}"
if [ -z "$PY_BIN" ]; then
  for c in "$HOME/.workbuddy/binaries/python/envs/default/bin/python" python3 /usr/bin/python3; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY_BIN="$c"; break; fi
  done
fi
echo "▸ 解释器：$PY_BIN"

echo "▸ 从本地数据库重建 data/desk.json"
"$PY_BIN" tools/export_desk_json.py

if [ "${1:-}" = "--push" ]; then
  if [ ! -d .git ] || ! git remote get-url origin >/dev/null 2>&1; then
    echo "✗ 还没有配置远端仓库。先跑一次首次部署："
    echo "    cd \"$ROOT\" && ./tools/deploy_github.sh"
    exit 1
  fi
  echo "▸ 变更文件"
  git status --short
  git add -A
  # ai_digest.json 在 .gitignore 里（怕密钥相关的东西被误传），但它正是网页要显示的内容，
  # 而且里面没有任何密钥，所以这里显式强制加入。
  [ -f data/ai_digest.json ] && git add -f data/ai_digest.json
  if git diff --cached --quiet; then
    echo "  没有变化，跳过提交"
  else
    git commit -m "data: 更新 $(date +%Y-%m-%d) 驾驶舱数据"
    echo "▸ 推送"
    git push
    echo "✓ 已推送。GitHub Pages 通常 1 分钟内生效。"
  fi
else
  echo
  echo "✓ 数据已更新。本地预览："
  echo "    cd \"$ROOT\" && \"$PY_BIN\" -m http.server 8791"
  echo "    然后打开 http://127.0.0.1:8791/"
  echo
  echo "  首次部署：./tools/deploy_github.sh"
  echo "  日常更新：./tools/publish.sh --push"
fi
