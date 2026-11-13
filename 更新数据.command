#!/bin/bash
# A股股债利差系统 · 一键更新数据
# 双击即可：从公开数据源重新抓取行情，覆盖 data.js
cd "$(dirname "$0")" || exit 1

echo "================================"
echo " A股股债利差系统 · 数据更新"
echo "================================"
echo ""

# ---- 定位 node（WorkBuddy 内置 → 系统 → Homebrew）----
NODE=""
for cand in \
  "$(command -v node 2>/dev/null)" \
  /Users/liamwang/.workbuddy-ai/binaries/node/versions/*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "$cand" ] && [ -x "$cand" ]; then NODE="$cand"; break; fi
done

if [ -z "$NODE" ]; then
  echo "未找到 node，无法更新数据。"
  echo "请安装 Node.js 后重试：https://nodejs.org/"
  echo ""
  read -r -p "按回车键关闭窗口..." _
  exit 1
fi

echo "使用 node：$NODE"
echo ""

"$NODE" update-data.mjs
RESULT=$?

echo ""
if [ $RESULT -eq 0 ]; then
  echo "数据已更新。刷新浏览器页面即可看到最新数值。"
  # 服务在跑就顺手打开页面
  if lsof -nP -iTCP:8899 -sTCP:LISTEN >/dev/null 2>&1; then
    open "http://127.0.0.1:8899/"
  else
    echo "提示：本地服务未运行，双击「启动.command」即可打开页面。"
  fi
else
  echo "更新失败，原有 data.js 未被修改。"
fi

echo ""
read -r -p "按回车键关闭窗口..." _
