#!/bin/bash
# Link2Chrome 状态检查脚本

echo "========================================="
echo "Link2Chrome 状态检查"
echo "========================================="
echo ""

# 1. 检查 MCP 服务器进程
echo "[1] MCP 服务器进程状态:"
if ps aux | grep "[p]ython -m server.main" > /dev/null 2>&1; then
    echo "  ✓ MCP 服务器正在运行"
    ps aux | grep "[p]ython -m server.main" | awk '{print "    PID: " $2 ", 运行时长: " $10}'
else
    echo "  ✗ MCP 服务器未运行"
fi

echo ""

# 2. 检查 WebSocket 端口
echo "[2] WebSocket 端口 (8765) 状态:"
if lsof -i :8765 > /dev/null 2>&1; then
    echo "  ✓ 端口 8765 已监听"
    lsof -i :8765 | tail -n +2 | while read line; do
        echo "    $line"
    done
else
    echo "  ✗ 端口 8765 未被监听"
fi

echo ""

# 3. 检查最近的日志
echo "[3] 最近的日志 (最后 5 行):"
LOG_FILE="/Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_$(date +%Y-%m-%d).log"
if [ -f "$LOG_FILE" ]; then
    tail -5 "$LOG_FILE" | while read line; do
        echo "    $line"
    done
else
    echo "  ℹ 今天还没有日志文件"
fi

echo ""

# 4. 检查 Chrome Extension 连接
echo "[4] Chrome Extension 连接状态:"
if [ -f "$LOG_FILE" ]; then
    if grep -q "Chrome Extension 已连接" "$LOG_FILE"; then
        LAST_CONN=$(grep "Chrome Extension 已连接" "$LOG_FILE" | tail -1)
        echo "  ✓ Extension 已连接"
        echo "    最后连接: $LAST_CONN"
    else
        echo "  ⚠️  Extension 未连接或日志中未找到连接记录"
    fi
else
    echo "  ℹ 无法检查(日志文件不存在)"
fi

echo ""

# 5. 检查错误
echo "[5] 最近的错误 (如果有):"
ERROR_LOG="/Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_error_$(date +%Y-%m-%d).log"
if [ -f "$ERROR_LOG" ] && [ -s "$ERROR_LOG" ]; then
    echo "  ⚠️  发现错误日志:"
    tail -3 "$ERROR_LOG" | while read line; do
        echo "    $line"
    done
else
    echo "  ✓ 没有错误"
fi

echo ""
echo "========================================="
echo "检查完成"
echo "========================================="
echo ""
echo "如果需要重启 MCP 服务器,运行:"
echo "  ./restart_mcp.sh"
echo ""
