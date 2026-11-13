#!/bin/bash
# A股股债利差系统 · 本地服务一键启动
# 双击即可：若服务未运行则启动，并自动打开浏览器
cd "$(dirname "$0")" || exit 1

PORT=8899
URL="http://127.0.0.1:$PORT/"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在运行：$URL"
else
  echo "正在启动本地服务（含 AI 代理）..."
  nohup /usr/bin/python3 "$(dirname "$0")/server.py" --port $PORT >/tmp/ebgap-8899.log 2>&1 &
  sleep 1.5
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "启动成功：$URL"
    echo "AI 复核：页面「AI 复核」卡片内粘贴模型 API Key 即可启用（Key 只存本机）"
  else
    echo "启动失败，请查看 /tmp/ebgap-8899.log"
    read -r -p "按回车键关闭窗口..." _
    exit 1
  fi
fi

open "$URL"
echo ""
echo "服务地址：$URL"
echo "（关闭本窗口不会停止服务；如需停止：lsof -ti:8899 | xargs kill）"
sleep 2
