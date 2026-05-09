#!/bin/bash
# Link2Chrome MCP Server 重启脚本

set -e

echo "========================================="
echo "Link2Chrome MCP Server 重启脚本"
echo "========================================="
echo ""

# 1. 停止所有旧进程
echo "[1/4] 停止旧的 MCP 服务器进程..."
pkill -f "python -m server.main" 2>/dev/null && echo "  ✓ 已停止旧进程" || echo "  ℹ 没有运行中的进程"

# 2. 等待端口释放
echo ""
echo "[2/4] 等待端口 8765 释放..."
sleep 2

# 检查端口是否仍被占用
if lsof -i :8765 > /dev/null 2>&1; then
    echo "  ⚠️  端口 8765 仍被占用，尝试强制清理..."
    PID=$(lsof -ti :8765)
    if [ ! -z "$PID" ]; then
        kill -9 $PID 2>/dev/null
        sleep 1
    fi
fi

if ! lsof -i :8765 > /dev/null 2>&1; then
    echo "  ✓ 端口 8765 现在可用"
else
    echo "  ✗ 端口 8765 仍被占用，请手动检查"
    exit 1
fi

# 3. 启动新的 MCP 服务器
echo ""
echo "[3/4] 启动新的 MCP 服务器..."
cd /Users/zhangyu/PycharmProjects/Link2Chrome

# 后台启动服务器
nohup /Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python -m server.main > /tmp/link2chrome_mcp.log 2>&1 &
PID=$!
echo "  ✓ MCP 服务器已启动 (PID: $PID)"

# 4. 等待服务器完全启动
echo ""
echo "[4/4] 等待服务器完全启动..."
sleep 3

if ps -p $PID > /dev/null 2>&1; then
    echo "  ✓ 服务器正在运行"
    echo ""
    echo "========================================="
    echo "✓ MCP 服务器重启成功!"
    echo "========================================="
    echo ""
    echo "日志文件:"
    echo "  - 主日志: /Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_$(date +%Y-%m-%d).log"
    echo "  - 错误日志: /Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_error_$(date +%Y-%m-%d).log"
    echo "  - 启动日志: /tmp/link2chrome_mcp.log"
    echo ""
    echo "下一步:"
    echo "  1. 打开 chrome://extensions/"
    echo "  2. 找到 'Link2Chrome' 扩展并点击刷新按钮"
    echo "  3. 运行: claude mcp list"
    echo ""
else
    echo "  ✗ 服务器启动失败"
    echo ""
    echo "请检查日志:"
    echo "  tail -20 /tmp/link2chrome_mcp.log"
    exit 1
fi
