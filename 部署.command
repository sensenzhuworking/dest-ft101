#!/bin/bash
# 双击这个文件即可。前提：已经在 GitHub 上建好一个 Public 空仓库。
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
clear

cat <<'BANNER'
╔════════════════════════════════════════════════════════════════╗
║  聚酯链驾驶舱 · 部署到 GitHub Pages                              ║
╚════════════════════════════════════════════════════════════════╝
   运行前请确认：你已经在 https://github.com/new 建好了一个
   Public 空仓库（不要勾 Add a README），并记下它的名字。

   等一下会问你 4 个问题，照着填就行。
   推到一半会弹认证框：
       Username → 你的 GitHub 用户名
       Password → 粘贴 Personal Access Token（不是登录密码）
BANNER

echo
echo "  按回车开始（Ctrl+C 取消）…"
read -r _

./tools/deploy_github.sh
RC=$?

echo
if [ $RC -ne 0 ]; then
  echo "────────────────────────────────────────────────────────────"
  echo "  没有成功。把上面的输出整段发给助手，我直接给你改。"
  echo "────────────────────────────────────────────────────────────"
else
  echo "  推送完成了。上面打印的两条链接照着点就行。"
fi

echo
echo "按回车键关闭窗口…"
read -r _
