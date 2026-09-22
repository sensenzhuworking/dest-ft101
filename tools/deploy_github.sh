#!/usr/bin/env bash
# ==========================================================================
#  一键部署到 GitHub Pages
#
#    ./tools/deploy_github.sh --check          # 只体检，不改任何东西
#    ./tools/deploy_github.sh                  # 交互式，会问你 4 个问题
#    ./tools/deploy_github.sh \
#        --user zhangsan --repo desk-7f3a --name "Zhang San" --email me@x.com
#
#  脚本做的事：体检 → 配凭据助手 → 建仓 → 提交 → 挂远端 → 推送 → 打印后续步骤
#  脚本不做的事：替你在 GitHub 网站上建仓库、开 Pages（这两步必须你手动点）
# ==========================================================================
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SITE_DIR"

USERNAME=""; REPO=""; GITNAME=""; GITEMAIL=""; REMOTE_URL=""; CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user)       USERNAME="${2:-}"; shift 2 ;;
    --repo)       REPO="${2:-}"; shift 2 ;;
    --name)       GITNAME="${2:-}"; shift 2 ;;
    --email)      GITEMAIL="${2:-}"; shift 2 ;;
    --remote-url) REMOTE_URL="${2:-}"; shift 2 ;;
    --check)      CHECK_ONLY=1; shift ;;
    -h|--help)    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
c_bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
c_head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ------------------------------------------------------------------ 1. 体检

c_head "1/6  环境体检"

GIT_BIN="$(command -v git || true)"
[ -n "$GIT_BIN" ] || { c_bad "找不到 git"; exit 1; }
GIT_VER="$(git --version | awk '{print $3}')"
c_ok "git $GIT_VER  ($GIT_BIN)"

# 版本太老会在 branch -M / init.defaultBranch 上翻车
GIT_MAJOR="${GIT_VER%%.*}"
GIT_REST="${GIT_VER#*.}"; GIT_MINOR="${GIT_REST%%.*}"
if [ "$GIT_MAJOR" -lt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -lt 28 ]; }; then
  c_warn "git 低于 2.28，分支名和凭据助手可能行为不一致，建议先升级"
else
  c_ok "git 版本够新（≥2.28）"
fi

if git ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1; then
  c_ok "能连上 github.com（HTTPS 通）"
else
  c_bad "连不上 github.com —— 先解决网络，再跑这个脚本"
  c_warn "如果用了代理：git config --global http.proxy http://127.0.0.1:7890"
  exit 1
fi

# 凭据助手：macOS 的标准位置经常缺失，退回到老安装里的那个
KC=""
for p in "$(dirname "$GIT_BIN")/git-credential-osxkeychain" \
         /usr/bin/git-credential-osxkeychain \
         /usr/local/git/bin/git-credential-osxkeychain \
         /Library/Developer/CommandLineTools/usr/bin/git-credential-osxkeychain; do
  if [ -x "$p" ] && printf 'protocol=https\nhost=github.com\n\n' | "$p" get >/dev/null 2>&1; then
    KC="$p"; break
  fi
done
if [ -n "$KC" ]; then
  c_ok "找到可用的钥匙串凭据助手：$KC"
else
  c_warn "没有钥匙串助手，会退回内存缓存（15 分钟后需重新输入 token）"
fi

# ---------------------------------------------------------------------------
# 密钥泄漏扫描
#
# 这里踩过一个坑：第一版只扫 *.js / *.html / *.json，而密钥真正可能被粘进
# 去的地方恰恰是 .env、*.py、*.sh、*.command —— 一个都没覆盖。守卫的意义就是
# 「宁可多扫」，所以现在扫「所有会被提交的文件」，不按扩展名挑。
#
#   在 git 仓库里 → git ls-files --cached --others --exclude-standard
#                   （= 真正会提交的集合，且自动尊重 .gitignore）
#   还没建仓      → 扫工作区全部，稍后由上面那条权威清单复核
#
#   $1 = block | warn   发现命中时是阻断还是仅告警
# ---------------------------------------------------------------------------
# 覆盖三类最常见的钥匙形态：模型 API key、GitHub PAT、AWS Access Key
SECRET_RE='(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})'

scan_secrets () {
  local mode="${1:-block}" list hits=0
  if git rev-parse --git-dir >/dev/null 2>&1; then
    list="$(git ls-files --cached --others --exclude-standard 2>/dev/null)"
  else
    list="$(find . -type f -not -path './.git/*' -not -name '.DS_Store' 2>/dev/null | sed 's|^\./||')"
  fi

  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    [ "$f" = ".env" ] && continue                      # .env 本来就该有钥匙，且它被 gitignore
    case "$(file -b --mime-encoding "$f" 2>/dev/null)" in
      binary|*binary*) continue ;;                     # 图片等二进制不当文本扫
    esac
    if grep -qIE "$SECRET_RE" "$f" 2>/dev/null; then
      hits=1
      grep -nIE "$SECRET_RE" "$f" 2>/dev/null | head -3 | while IFS= read -r ln; do
        c_bad "$f : $ln"
      done
    fi
  done <<< "$list"

  if [ "$hits" -eq 0 ]; then
    c_ok "没发现密钥字面量"
    return 0
  fi
  if [ "$mode" = "block" ]; then
    c_bad "上面这些文件里有疑似密钥 —— 绝对不能提交"
    c_warn "真钥匙放进 .env（已在 .gitignore 里），模板文件里只留占位符"
    return 1
  fi
  c_warn "上面是仅告警（此时还没建仓，被 .gitignore 忽略的文件不会提交）；提交前还会再查一次"
  return 0
}

c_head "2/6  密钥泄漏预检"
if [ "$CHECK_ONLY" -eq 1 ]; then
  scan_secrets warn
else
  scan_secrets block || exit 1
fi

if [ -f .env ]; then
  c_warn ".env 存在"
  grep -qE '^/?\.env$' .gitignore && c_ok ".env 已在 .gitignore 里，不会被提交" \
    || { c_bad ".env 没被忽略！先加进 .gitignore"; exit 1; }
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  c_head "体检完成（--check 模式，未做任何改动）"
  exit 0
fi

# ------------------------------------------------------------------ 2. 收集信息

c_head "3/6  需要你填 4 项"
echo "  （GitHub 用户名和仓库名要跟你在网站上建的那个一模一样）"
echo

ask() { # ask <变量名> <提示> <示例>
  local __v="$1" __p="$2" __e="$3" __cur="${!1:-}"
  if [ -n "$__cur" ]; then printf '  %s = %s（已由参数提供）\n' "$__p" "$__cur"; return; fi
  printf '  %s（例：%s）\n  > ' "$__p" "$__e"
  read -r __in
  printf -v "$__v" '%s' "$__in"
}

[ -n "$USERNAME" ] || ask USERNAME "GitHub 用户名" "zhangsan"
[ -n "$REPO" ]     || ask REPO     "仓库名（建议起个不好猜的）" "desk-7f3a"
[ -n "$GITNAME" ]  || ask GITNAME  "提交记录里显示的名字" "Zhang San"
[ -n "$GITEMAIL" ] || ask GITEMAIL "你的邮箱（GitHub 账号邮箱）" "you@example.com"

[ -n "$USERNAME" ] && [ -n "$REPO" ] && [ -n "$GITNAME" ] && [ -n "$GITEMAIL" ] \
  || { c_bad "四项都不能空"; exit 1; }

case "$REPO" in
  *" "*|*/*) c_bad "仓库名不能含空格或斜杠"; exit 1 ;;
esac

[ -n "$REMOTE_URL" ] || REMOTE_URL="https://github.com/${USERNAME}/${REPO}.git"

echo
c_ok "将推送到：$REMOTE_URL"

# ------------------------------------------------------------------ 3. 配 git

c_head "4/6  配置 git 与凭据"

# 凭据助手是便利项，不是必需品 —— 写不进去也要能继续部署，
# 大不了每次推送重新输一次 token。
if [ -n "$KC" ]; then
  if git config --global credential.helper "$KC" 2>/dev/null; then
    c_ok "凭据助手已设为钥匙串（token 存 macOS 钥匙串，只输一次）"
  else
    c_warn "写全局配置失败，改用本仓库配置"
    git config credential.helper "$KC"
    c_ok "凭据助手（仅本仓库）已设为钥匙串"
  fi
else
  c_warn "没有钥匙串助手，每次推送需要重新输入 token"
fi

# 先建仓，再写仓库级配置 —— 顺序反了会报 "not in a git directory"
if [ ! -d .git ]; then
  git init -q
  c_ok "已初始化仓库"
else
  c_ok "已经是 git 仓库，沿用"
fi

# 身份只写进这个仓库，不动你的全局配置
git config user.name  "$GITNAME"
git config user.email "$GITEMAIL"
# 中文文件名默认会被转义成 \344\275\223... 这样看起来像乱码，关掉
git config core.quotepath false
c_ok "仓库内身份：$GITNAME <$GITEMAIL>"

# ------------------------------------------------------------------ 4. 提交

c_head "5/6  提交"

git checkout -q -B main 2>/dev/null || git symbolic-ref HEAD refs/heads/main
c_ok "当前分支：$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"

# 现在仓库已经存在，可以用 git 自己的清单做一次权威扫描：
# 这就是「真正会被提交的文件集合」，且自动尊重 .gitignore。
printf '  '
scan_secrets block || { c_bad "已中止，未提交任何内容"; exit 1; }

git add -A
if git diff --cached --quiet 2>/dev/null; then
  c_warn "没有新变更（可能之前已提交过）"
else
  git commit -q -m "init: 聚酯链驾驶舱"
  c_ok "已提交：$(git log -1 --pretty=%h\ %s)"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
  c_ok "已更新 origin"
else
  git remote add origin "$REMOTE_URL"
  c_ok "已添加 origin"
fi

# ------------------------------------------------------------------ 5. 推送

c_head "6/6  推送"
cat <<'TIP'
  ┌──────────────────────────────────────────────────────────────┐
  │ 下面会弹出用户名 / 密码输入框：                                │
  │   Username  → 你的 GitHub 用户名                              │
  │   Password  → 粘贴 Personal Access Token（不是登录密码！）      │
  │ 粘贴时屏幕不显示字符，这是正常的。                              │
  └──────────────────────────────────────────────────────────────┘
TIP
echo

if git push -u origin main; then
  printf '\n'
  c_ok "推送成功 🎉"
else
  printf '\n'
  c_bad "推送失败。按下面三种情况对号入座："
  echo
  echo "  【A】提示 Authentication failed / 403"
  echo "      → token 不对或没勾 repo 权限。去 https://github.com/settings/tokens"
  echo "        重新生成 classic token，勾上 repo。"
  echo "      → 如果报的是 workflow scope，那是推送 .github/workflows/ 需要额外权限："
  echo "        编辑现有 token，把 workflow 也勾上（token 值不变），或直接访问"
  echo "        https://github.com/settings/tokens/new?scopes=repo,workflow&description=desk"
  echo "      → 如果之前存过旧凭据，先清掉："
  echo "        git credential-osxkeychain erase <<< \$'protocol=https\\nhost=github.com\\n'"
  echo "        （或换成 --remote-url 用 ssh）"
  echo
  echo "  【B】提示 Repository not found"
  echo "      → 仓库还没在网站上建，或用户名/仓库名拼错了。"
  echo "      → 也检查账号是否对：访问 https://github.com/${USERNAME}/${REPO}"
  echo
  echo "  【C】提示 failed to push some refs / rejected"
  echo "      → 远端已有提交（建仓库时勾了 README）。执行："
  echo "        git pull --rebase origin main && git push -u origin main"
  exit 1
fi

# ------------------------------------------------------------------ 收尾

cat <<EOF

══════════════════════════════════════════════════════════════════
  还剩两步，必须你手动做（我碰不到 GitHub 网站的界面）
══════════════════════════════════════════════════════════════════

▸ 第 1 步：确认仓库是 Public
  https://github.com/${USERNAME}/${REPO}/settings
  → 拉到底 Danger Zone → Change repository visibility
  → 免费账号必须是 Public，否则 Pages 开不了

▸ 第 2 步：打开 Pages
  https://github.com/${USERNAME}/${REPO}/settings/pages
  → Source 选  Deploy from a branch
  → Branch 选  main   目录选  / (root)
  → 点 Save

▸ 等 1–10 分钟（不是即时的），然后访问：

      https://${USERNAME}.github.io/${REPO}/

══════════════════════════════════════════════════════════════════
  上线后验证（用无痕窗口打开，排除缓存和登录态）
══════════════════════════════════════════════════════════════════

  · K 线出来了          → 新浪源在公网可用
  · 右上情报流有条目      → 东财源可用
  · 全球市场里有 A股 / 港股 / 美股 / 美债
                        → 腾讯和 CNBC 可用
  · 手机浏览器也开一次    → 移动端布局没散

══════════════════════════════════════════════════════════════════
  以后怎么更新
══════════════════════════════════════════════════════════════════

  改了代码或数据之后，一条命令：

      ./tools/publish.sh --push

  它会重跑数据导出 → 提交 → 推送，等一分钟刷新页面即可。

EOF
