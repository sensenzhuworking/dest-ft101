#!/usr/bin/env bash
# ==========================================================================
#  最简部署：只给你一个 GitHub token，剩下的全自动
#
#  和 deploy_github.sh 的区别：
#    deploy_github.sh  需要你先在网页上建仓库、开 Pages（3 处手动点击）
#    这个脚本          用 GitHub API 把「建仓库」和「开 Pages」都做掉
#
#  你唯一要做的事：生成一个 classic token（勾 repo），粘贴进来。
#
#  用法：
#    ./tools/deploy_via_api.sh                       # 交互式，隐藏输入 token
#    GITHUB_TOKEN=ghp_xxx ./tools/deploy_via_api.sh --repo desk-7f3a
#
#  token 只做三件事：认你是谁、建仓库、开 Pages。
#  它不会被打印、不会被写进任何文件、不会进 git 配置 —— 只存进 macOS 钥匙串。
# ==========================================================================
set -uo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SITE_DIR"

REPO=""; TOKEN="${GITHUB_TOKEN:-}"; VISIBILITY="public"; DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)   REPO="${2:-}"; shift 2 ;;
    --token)  TOKEN="${2:-}"; shift 2 ;;   # 不推荐：会进 shell 历史
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
c_bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
c_head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

API="https://api.github.com"
UA="curl/8"
need() { command -v "$1" >/dev/null 2>&1 || { c_bad "缺少 $1"; exit 1; }; }
need curl; need git

# 用 python 解 JSON。用 sed 抠 JSON 字段在出错响应上很容易抠错，
# 而这里恰恰是出错时最需要看准的地方。
PY=""
for p in /usr/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$p" >/dev/null 2>&1; then PY="$p"; break; fi
done

jget() { # jget <json字符串> <字段.路径>
  [ -n "$PY" ] || return 0
  printf '%s' "$1" | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None:
        break
if d is None:
    sys.exit(0)
print(d if isinstance(d, (str, int, float)) else json.dumps(d, ensure_ascii=False))
' "$2" 2>/dev/null
}

jfile() { # jfile <文件> <字段.路径>
  [ -f "$1" ] && jget "$(cat "$1")" "$2"
}

# ------------------------------------------------------------------ token

c_head "1/6  拿到 token"

if [ -z "$TOKEN" ] && [ -f .env ]; then
  TOKEN="$(grep -E '^GITHUB_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
  [ -n "$TOKEN" ] && c_ok "从 .env 读到了 GITHUB_TOKEN"
fi

if [ -z "$TOKEN" ]; then
  cat <<'TIP'
  需要一个 GitHub token。生成步骤（30 秒）：

    1. 打开这个链接（权限已经帮你勾好了）：
         https://github.com/settings/tokens/new?scopes=repo,workflow&description=desk-deploy
    2. Note 随便写，Expiration 选 90 days
    3. 确认勾上了 repo（链接里已经带上了，扫一眼就行）
    4. 点最下面 Generate token
    5. 复制那串 ghp_ 开头的字符串（离开页面就再也看不到了）

  下面粘贴时不会显示任何字符，这是正常的。粘贴完按回车。
TIP
  printf '\n  Token: '
  read -rs TOKEN
  printf '\n'
fi

[ -n "$TOKEN" ] || { c_bad "没有 token，退出"; exit 1; }
c_ok "已收到 token（${#TOKEN} 位，不会再显示）"

# ------------------------------------------------------------------ 校验

c_head "2/6  校验 token 并确认你的账号"

me_json="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" \
             -H "Accept: application/vnd.github+json" -H "User-Agent: $UA" "$API/user" 2>/dev/null)"
LOGIN="$(jget "$me_json" login)"

if [ -z "$LOGIN" ]; then
  msg="$(jget "$me_json" message)"
  c_bad "token 用不了：${msg:-无法识别返回内容}"
  case "$msg" in
    *"Bad credentials"*) c_warn "token 抄错了或已过期，重新生成一个" ;;
    *) c_warn "确认勾了 repo 权限；细粒度 token 需要 Administration + Pages 写权限，classic token 更省事" ;;
  esac
  exit 1
fi
c_ok "账号：$LOGIN"

scopes="$(curl -sS -m 20 -I -H "Authorization: Bearer $TOKEN" -H "User-Agent: $UA" "$API/user" 2>/dev/null \
          | tr -d '\r' | sed -n 's/^[Xx]-[Oo]auth-[Ss]copes:[[:space:]]*//p' | head -1)"
if printf '%s' "$scopes" | grep -q 'repo'; then
  c_ok "权限含 repo"
elif [ -n "$scopes" ]; then
  c_bad "权限里没有 repo（当前：$scopes）—— 去 token 设置里补上 repo"
  exit 1
fi

# ------------------------------------------------------------------ 仓库名

c_head "3/6  仓库名"

if [ -z "$REPO" ]; then
  # 给一个不好猜的默认名
  DEF="desk-$(printf '%s' "$LOGIN" | cksum | cut -c1-4)"
  printf '  仓库名（回车用默认值 %s）\n  > ' "$DEF"
  read -r REPO
  [ -n "$REPO" ] || REPO="$DEF"
fi
case "$REPO" in
  *" "*|*/*) c_bad "仓库名不能含空格或斜杠"; exit 1 ;;
esac

if curl -sS -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
     -H "User-Agent: $UA" "$API/repos/$LOGIN/$REPO" 2>/dev/null | grep -q '^200$'; then
  c_warn "仓库 $LOGIN/$REPO 已存在，直接往里推"
else
  if [ "$DRY" -eq 1 ]; then
    c_ok "[dry-run] 会创建公开仓库 $LOGIN/$REPO"
  else
    code="$(curl -sS -m 30 -o /tmp/gh_create.json -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
        -H "User-Agent: $UA" "$API/user/repos" \
        -d "{\"name\":\"$REPO\",\"private\":false,\"auto_init\":false,\"description\":\"个人用能化产业链驾驶舱\"}" 2>/dev/null)"
    if [ "$code" = "201" ]; then
      c_ok "已创建公开仓库：https://github.com/$LOGIN/$REPO"
    else
      c_bad "建仓库失败（HTTP $code）"
      printf '      原因：%s\n' "$(jfile /tmp/gh_create.json message)"
      exit 1
    fi
  fi
fi

URL="https://$LOGIN.github.io/$REPO/"

if [ "$DRY" -eq 1 ]; then
  c_head "dry-run 结束：仓库 $LOGIN/$REPO，站点将是 $URL"
  exit 0
fi

# ------------------------------------------------------------------ 提交推送

c_head "4/6  提交并推送"

if [ ! -d .git ]; then git init -q; c_ok "已初始化仓库"; else c_ok "沿用已有仓库"; fi
git checkout -q -B main 2>/dev/null || git symbolic-ref HEAD refs/heads/main

if ! git config user.name >/dev/null 2>&1; then
  git config user.name  "$LOGIN"
  git config user.email "$LOGIN@users.noreply.github.com"
  c_ok "提交身份：$LOGIN <$LOGIN@users.noreply.github.com>（只写进本仓库）"
fi
git config core.quotepath false

# 密钥预检（复用 deploy_github.sh 的规则）
SECRET_RE='(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})'
leak=0
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  [ "$f" = ".env" ] && continue
  case "$(file -b --mime-encoding "$f" 2>/dev/null)" in binary|*binary*) continue ;; esac
  if grep -qIE "$SECRET_RE" "$f" 2>/dev/null; then
    grep -nIE "$SECRET_RE" "$f" 2>/dev/null | head -2 | while IFS= read -r ln; do c_bad "$f : $ln"; done
    leak=1
  fi
done <<< "$(find . -type f -not -path './.git/*' -not -name '.DS_Store' | sed 's|^\./||')"
[ "$leak" -eq 1 ] && { c_bad "待提交文件里有疑似密钥，已中止（真钥匙请放 .env）"; exit 1; }
c_ok "密钥预检通过"

git add -A
if git diff --cached --quiet 2>/dev/null; then
  c_warn "没有新变更"
else
  git commit -q -m "init: 聚酯链驾驶舱"
  c_ok "已提交：$(git log -1 --pretty=%h\ %s)"
fi

# token 只进钥匙串，不进 git config、不进 remote URL
if [ -x /usr/local/git/bin/git-credential-osxkeychain ] || [ -x /usr/bin/git-credential-osxkeychain ]; then
  printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n' "$TOKEN" \
    | git credential approve 2>/dev/null && c_ok "token 已存进 macOS 钥匙串（以后推送不用再输）"
else
  c_warn "没有钥匙串助手，本次推送用临时凭据（不会落盘）"
fi

git remote get-url origin >/dev/null 2>&1 \
  && git remote set-url origin "https://github.com/$LOGIN/$REPO.git" \
  || git remote add origin "https://github.com/$LOGIN/$REPO.git"

if git push -u origin main 2>/tmp/push_err.txt; then
  c_ok "推送成功"
else
  c_bad "推送失败："
  sed 's/^/      /' /tmp/push_err.txt | tail -5
  c_warn "多半是 token 少了 repo 权限，或凭据助手缓存了旧密码"
  exit 1
fi

# ------------------------------------------------------------------ 开 Pages

c_head "5/6  开启 GitHub Pages"

pg_code="$(curl -sS -m 30 -o /tmp/gh_pages.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -H "User-Agent: $UA" "$API/repos/$LOGIN/$REPO/pages" \
    -d '{"source":{"branch":"main","path":"/"}}' 2>/dev/null)"

case "$pg_code" in
  201) c_ok "Pages 已开启：分支 main，目录 /" ;;
  409) c_warn "Pages 之前已开启，改成 main / 重新指向"
       curl -sS -m 30 -o /dev/null -X PUT \
         -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
         -H "User-Agent: $UA" "$API/repos/$LOGIN/$REPO/pages" \
         -d '{"source":{"branch":"main","path":"/"}}' 2>/dev/null && c_ok "已更新" ;;
  *)   c_bad "开启失败（HTTP $pg_code）"
       printf '      原因：%s\n' "$(jfile /tmp/gh_pages.json message)"
       c_warn "不影响推送，你可以手动开：https://github.com/$LOGIN/$REPO/settings/pages" ;;
esac

# ------------------------------------------------------------------ 等上线

c_head "6/6  等它上线（首次构建要几分钟，不要关窗口）"

printf '  目标地址：%s\n\n' "$URL"
live=0
for i in $(seq 1 40); do
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then live=1; break; fi
  printf '\r  等待中… %ds（HTTP %s）   ' "$((i*15))" "$code"
  sleep 15
done
printf '\n\n'

if [ "$live" -eq 1 ]; then
  cat <<EOF
  ╔══════════════════════════════════════════════════════════════╗
  ║  上线了                                                      ║
  ╚══════════════════════════════════════════════════════════════╝

      $URL

  在手机上也打开一次，确认移动端布局没散。
  这个链接任何地方都能打开（不需要分享给谁，但拿到链接的人也能看，
  所以别往里放持仓、成本、交易记录）。
EOF
else
  cat <<EOF
  构建还没完成，这很正常 —— GitHub Pages 首次发布要 1–10 分钟。
  过几分钟自己点开看看：

      $URL

  如果十分钟后还是 404，去这里看构建状态：
      https://github.com/$LOGIN/$REPO/actions
EOF
fi

cat <<EOF

  以后更新（改了数据或代码）：

      cd "$SITE_DIR" && ./tools/publish.sh --push

  等一分钟刷新页面即可。token 存在钥匙串里，不会再问你。

EOF
